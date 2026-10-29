// The language worker's .flow state. Source ranges stay here: a parse sends only the docs, their problems
// and the last good docs, which keeps the posted result small. A .flow file is a board of frames (one diagram each);
// span, edit and outline requests name a frame and are answered against the cached parse of one text version, in
// whole-file positions, and a request planned on an older version is refused.
import { insertFlow } from "./insert";
import { type BoardParse, type FrameParse, parseBoard, shiftEdits, shiftSpan, splitFrames } from "./board";
import { completeFlow, type FlowCompletionResult, kindItems } from "./complete";
import type { TextEdit } from "../protocol";
import { pasteLines } from "./clip";
import { appendFrames, deleteFrame, duplicateFrame, renameFrame } from "./boardEdits";
import { applyFlowEdit, type FlowEditOp, type FlowEditResult } from "./edits";
import { type DiagramKind, type FlowDoc, MAX_BOARD_SHAPES } from "./model";
import { columnsOf, flowOutline } from "./outline";
import type { FlowOutline } from "../../api/types";
import { type FlowParse, type FlowSpan, parseFlow } from "./parse";
import type { FlowProblem } from "./problems";

/** One frame of a parse, in file positions; `line` is the 1-based file line it starts on. */
export type FrameResult = {
  index: number;
  kind: DiagramKind | null;
  title: string;
  from: number;
  to: number;
  line: number;
  /** Null while the frame has an error. */
  doc: FlowDoc | null;
  /** The frame's most recent good doc (kept by its title), sent only while `doc` is null. */
  lastValid: FlowDoc | null;
  /** The doc's wire id; null while `doc` is null. */
  docId: number | null;
  /** `lastValid`'s wire id; null when there is none. */
  lastValidId: number | null;
  /** Set (true) only on an ER frame still in the old form, whose edits wait for "Rewrite as table blocks". */
  oldEr?: true;
};

/** What a parse posts to the editor side. */
export type FlowResult = {
  /** Frame 0's kind, doc and last good doc, so a one-diagram file reads as it always did. */
  kind: FlowParse["kind"];
  /** Null while frame 0 has an error. */
  doc: FlowDoc | null;
  /** The whole board's, in file positions. */
  problems: FlowProblem[];
  /** Frame 0's most recent good doc, sent only while `doc` is null (else `doc` is it), so it is sent once. */
  lastValid: FlowDoc | null;
  frames: FrameResult[];
  /** Set (true) only when frame 0 is an ER frame still in the old form. */
  oldEr?: true;
  /** The text version this result is for; span and edit requests name it. */
  version: number;
};

export type FlowSpansResult =
  | { stale: true }
  | {
      stale: false;
      /** Each asked key (`node:<name>`, `group:<name>`, `link:<i>`, `diagram`, `kind`, `title`); null when the text has none. */
      spans: Record<string, FlowSpan | null>;
      /** The line each asked name is defined on; null when it is not defined. */
      lineOf: Record<string, number | null>;
    };

/** Several canvas actions as one (a multi-node delete): one edit list, one undo entry, all or nothing. */
export type FlowBatchOp = { op: "batch"; ops: FlowEditOp[] };

/**
 * A paste (diagram-ux-research F2): the clipboard's .flow lines written into the text with free names, as one edit
 * list and one undo entry. A mind map paste goes under a topic or after one (a duplicate).
 */
export type FlowPasteOp = { op: "paste"; text: string; under?: string; after?: string };

/**
 * Step 10 (F28): converted Mermaid (a whole .flow file of the same kind) written into the text, at the end or at `at`,
 * taken names made free, as one edit list and one undo entry.
 */
export type FlowInsertOp = { op: "insert"; text: string; at?: number };

/**
 * A board's own edit: rename, duplicate or delete a frame, or append whole frames from text (the Shelf). It runs on
 * the whole text, so a request's `frameIndex` is ignored.
 */
export type FlowBoardOp =
  | { op: "appendFrames"; frames: string[] }
  | { op: "renameFrame"; frameIndex: number; title: string }
  | { op: "deleteFrame"; frameIndex: number }
  | { op: "duplicateFrame"; frameIndex: number };

/** What a canvas action asks the worker for. */
export type FlowRequestOp = FlowEditOp | FlowBatchOp | FlowPasteOp | FlowInsertOp | FlowBoardOp;

/** Applies sorted, non-overlapping edits to `text`. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

/**
 * Runs the ops in turn on the text, parsing again between them, and returns one replace of the changed span
 * against the original text. An op that does not apply refuses the whole batch (an empty list, with that op's note).
 */
export function applyFlowBatch(text: string, parse: FlowParse, ops: readonly FlowEditOp[]): FlowEditResult {
  // Only the edits: the worker answers a canvas batch without posting the whole text back.
  const { edits, note } = applyFlowSteps(text, parse, ops.length, (_, i) => ops[i]);
  return note === undefined ? { edits } : { edits, note };
}

/**
 * Like `applyFlowBatch`, but each op is made from the parse of the text the steps before it left (and that text), so
 * an op that names a link by its index sees the right one. `opAt` returning null refuses the whole batch. The final
 * text comes back with the edit, so a caller that wants it need not apply the edit again.
 */
export function applyFlowSteps(
  text: string,
  parse: FlowParse,
  count: number,
  opAt: (parse: FlowParse, i: number, text: string) => FlowEditOp | null,
): FlowEditResult & { text?: string } {
  let t = text;
  let p = parse;
  for (let i = 0; i < count; i++) {
    const op = opAt(p, i, t);
    if (!op) return { edits: [] };
    const r = applyFlowEdit(t, p, op);
    // The refusing op's note says why, for the caller to show.
    if (r.edits.length === 0) return r.note === undefined ? { edits: [] } : { edits: [], note: r.note };
    t = applyEdits(t, r.edits);
    if (i < count - 1) p = parseFlow(t);
  }
  if (t === text) return { edits: [] };
  let a = 0;
  while (a < t.length && a < text.length && t[a] === text[a]) a++;
  let b = 0;
  while (b < t.length - a && b < text.length - a && t[t.length - 1 - b] === text[text.length - 1 - b]) b++;
  return { edits: [{ from: a, to: text.length - b, insert: t.slice(a, t.length - b) }], text: t };
}

/** The outline of the text of `version`, or `{ stale: true }` once the text has changed. */
export type FlowOutlineAnswer = { stale: true } | { stale: false; outline: FlowOutline };

/** A frame's problem for the board Ask: its line in the frame and its message. */
export type BoardFrameProblem = { line: number; message: string };

/**
 * One frame of the board for the board Ask: its place in the text, its outline in file lines and
 * its problems in frame lines (errors first, at most `BOARD_PROBLEMS_MAX`, each cut to `BOARD_PROBLEM_CHARS`).
 */
export type BoardOutlineFrame = {
  index: number;
  title: string;
  kind: DiagramKind | null;
  from: number;
  to: number;
  line: number;
  outline: FlowOutline;
  problems: BoardFrameProblem[];
};

/** Every frame's outline and problems of the text of `version`, or `{ stale: true }` once the text has changed. */
export type BoardOutlineAnswer = { stale: true } | { stale: false; frames: BoardOutlineFrame[] };

/** The most problems a frame sends with the board Ask, and the longest message (Decision 1; the Core caps them too). */
export const BOARD_PROBLEMS_MAX = 10;
export const BOARD_PROBLEM_CHARS = 200;

/** `message` cut to BOARD_PROBLEM_CHARS characters, never inside a character. */
function cutMessage(message: string): string {
  // Characters (code points), as the Core counts them; the check and the cut both count them.
  const chars = Array.from(message);
  return chars.length <= BOARD_PROBLEM_CHARS ? message : chars.slice(0, BOARD_PROBLEM_CHARS).join("");
}

/** A frame's problems for the board Ask: errors before hints, each in text order, capped. */
function frameProblems(problems: readonly FlowProblem[]): BoardFrameProblem[] {
  const out: BoardFrameProblem[] = [];
  for (const severity of ["error", "hint"] as const) {
    for (const p of problems) {
      if (out.length === BOARD_PROBLEMS_MAX) return out;
      if (p.severity === severity) out.push({ line: p.line, message: cutMessage(p.message) });
    }
  }
  return out;
}

/** Edits for a canvas action, or `{ stale: true }` when the text has changed since the version it was planned on. */
export type FlowEditAnswer = { stale: true } | ({ stale: false } & FlowEditResult);

/** Completion items; `stale` when a newer text was still waiting to be parsed (it has been parsed now, so ask again). */
export type FlowCompleteAnswer = FlowCompletionResult & { stale?: true };

/** A frame that left the board in a shrink, with its last good doc, its place and its kind and title. */
type Gone = { pair: string; index: number; doc: FlowDoc };

/**
 * The frames that left in the latest shrink, when that shrink only took frames away (as many kinds and titles went
 * as frames): a later frame whose kind word is being retyped is no header for a keystroke or two (its text joins the
 * frame above), and takes its own doc back when it is a frame again at its place, at the old `count`. A new shrink
 * replaces it, and it is dropped by the first parse at another count and after `GONE_PARSES` parses, so it never
 * holds more than the frames of one shrink, nor for long (B4 Task 2b, fix round 2).
 */
type GoneSet = { count: number; age: number; entries: Gone[] };

/** How many parses after its shrink a gone frame can still come back. */
export const GONE_PARSES = 3;

/**
 * `lasts` holds each current frame's own last good doc by index, and `gone` the frames of the latest shrink; both are
 * rebuilt on each parse.
 */
type Cached = { version: number; text: string; board: BoardParse; lasts: (FlowDoc | null)[]; gone: GoneSet | null; icons: number };

/** A paste or insert refused because the board would be over MAX_BOARD_SHAPES. */
export const BOARD_FULL = "This board would have more than 10,000 shapes, so nothing was added.";

/** A frame being started: `diagram` at column 0 and a partial kind. */
const HEADER_START = /^diagram[ \t]+(\w*)$/;

/** Runs `edit` on the frame's own text; the edits are relative to the frame. */
function editFrame(f: FrameParse, edit: Exclude<FlowRequestOp, FlowBoardOp>): FlowEditResult {
  if (edit.op === "batch") return applyFlowBatch(f.text, f.parse, edit.ops);
  if (edit.op === "insert") return insertFlow(f.text, f.parse, edit.text, edit.at === undefined ? undefined : Math.min(Math.max(edit.at - f.from, 0), f.text.length));
  if (edit.op === "paste") {
    const place = edit.under !== undefined ? { under: edit.under } : edit.after !== undefined ? { after: edit.after } : undefined;
    return pasteLines(f.text, f.parse, edit.text, place);
  }
  return applyFlowEdit(f.text, f.parse, edit);
}

/** The kind and title of a frame, one string: a frame's identity in the worker, while no other frame shares it. */
const kindTitle = (p: { kind: string | null; title: string }) => `${p.kind ?? ""}\u0000${p.title}`;

/** Each kind and title held by exactly one of `frames`, to that frame's index. */
function soleKindTitles(frames: readonly { parse: { kind: string | null; title: string } }[]): Map<string, number> {
  const at = new Map<string, number>();
  frames.forEach((f, i) => {
    const k = kindTitle(f.parse);
    at.set(k, at.has(k) ? -1 : i);
  });
  return at;
}

/** What `lastFor` reads about the board and the parse before it, made once per parse. */
type LastContext = { board: BoardParse; old: Cached | undefined; titles: ReadonlySet<string>; now: Map<string, number>; before: Map<string, number> };

/**
 * The last good doc for frame `i` of the board, only ever its own (B4 Task 2b): its own doc, else the last good one
 * of the frame it was before. That is the one frame of its kind and title, when exactly one frame had them before and
 * one has them now (a moved frame); else, when that pair was on no frame before, the frame that left at this place in
 * the latest shrink, now that the board has its count again (a later frame's kind word retyped, `GoneSet`); else the
 * frame at its place, when the count is the same and the title is the same or one no frame has now (a frame renamed
 * where it is). The doc must be of the frame's kind; a frame whose kind word is half typed (no kind) keeps only the
 * doc of its own last known kind, under the same title. Never a doc kept for a title another frame holds; with none,
 * the frame draws nothing.
 */
function lastFor(c: LastContext, i: number): FlowDoc | null {
  const p = c.board.frames[i].parse;
  if (p.doc) return p.doc;
  const old = c.old;
  if (!old) return null;
  /** `d` when it is of this frame's kind, or of `known` (the source frame's last known kind) while this one has none. */
  const fits = (d: FlowDoc | null | undefined, known: string | null) => (d && (p.kind !== null ? d.kind === p.kind : known !== null && d.kind === known) ? d : null);
  const knownAt = (j: number) => old.board.frames[j].parse.kind ?? old.lasts[j]?.kind ?? null;
  const n = c.board.frames.length;
  const k = kindTitle(p);
  if (p.title !== "" && c.now.get(k) === i) {
    const j = c.before.get(k);
    if (j !== undefined && j >= 0) return fits(old.lasts[j], knownAt(j));
    const g = j === undefined && old.gone?.count === n ? old.gone.entries.find((x) => x.pair === k && x.index === i) : undefined;
    if (g) return fits(g.doc, g.doc.kind);
  }
  if (old.board.frames.length !== n) return null;
  const was = old.board.frames[i].parse;
  if (was.title !== p.title && (p.kind === null || c.titles.has(was.title))) return null;
  return fits(old.lasts[i], knownAt(i));
}

/**
 * The gone frames after this parse (`GoneSet`): a shrink that only took frames away keeps those that had a last good
 * doc; else the latest shrink's are kept while the count stays as the shrink left it, for `GONE_PARSES` parses.
 */
function goneAfter(c: LastContext): GoneSet | null {
  const old = c.old;
  if (!old) return null;
  const n = c.board.frames.length;
  const was = old.board.frames.length;
  if (n < was) {
    const here = new Set(c.board.frames.map((f) => kindTitle(f.parse)));
    const left = old.board.frames.filter((f) => !here.has(kindTitle(f.parse))).length;
    if (left !== was - n) return null;
    const entries: Gone[] = [];
    for (const [pair, j] of c.before) {
      const doc = old.lasts[j];
      if (j >= 0 && doc && !here.has(pair)) entries.push({ pair, index: j, doc });
    }
    return entries.length > 0 ? { count: was, age: 1, entries } : null;
  }
  const g = old.gone;
  return g && n === was && g.age < GONE_PARSES ? { ...g, age: g.age + 1 } : null;
}

/**
 * How many closed diagram ids the worker remembers, newest kept: a parse that arrives just after its tab closed is
 * dropped, and older ids are forgotten so the set does not grow with every diagram ever opened.
 */
export const CLOSED_KEPT = 64;

/**
 * `row:<table>:<index>`: that ER table's column line, its `index`-th row (B3 decision 13, Show in the text for a
 * column); null when the table has no such row.
 */
function rowSpan(parse: FlowParse, key: string): FlowSpan | null {
  const cut = key.lastIndexOf(":");
  const index = Number(key.slice(cut + 1));
  const line = Number.isInteger(index) && index >= 0 ? parse.rowsOf(key.slice("row:".length, cut))[index]?.line : undefined;
  return line ? { from: line.from, to: line.to } : null;
}

const docIds = new WeakMap<FlowDoc, number>();
let nextDocId = 1;
/** One id per doc object for as long as it lives, so an unchanged frame's doc is the same id parse after parse. */
function idOf(doc: FlowDoc | null): number | null {
  if (!doc) return null;
  let id = docIds.get(doc);
  if (id === undefined) docIds.set(doc, (id = nextDocId++));
  return id;
}

/** Frame `i`'s outline from the cached parse, read with its own text (ER columns), in file lines. */
function frameOutline(c: Cached, i: number): FlowOutline {
  const f = c.board.frames[i];
  const o = flowOutline(f.parse, c.lasts[i], c.text.slice(f.from, f.to));
  const by = f.line - 1;
  if (by === 0) return o;
  return {
    ...o,
    nodes: o.nodes.map((n) => ({ ...n, line: n.line + by })),
    groups: o.groups.map((g) => ({ ...g, line: g.line + by })),
    links: o.links.map((l) => ({ ...l, line: l.line + by })),
  };
}

export function createFlowService() {
  const docs = new Map<string, Cached>();
  const closed = new Set<string>();
  let icons: readonly string[] = [];
  /** The same names as a set for the parser's unknown-icon check; undefined until the list arrives. */
  let iconSet: ReadonlySet<string> | undefined;
  /** The nearest icon for each misspelt name, kept while the list is the same. */
  const iconNear = new Map<string, string | null>();
  let nextVersion = 1;
  /** Bumped by `setIcons`: a cached board parsed with other icons is not reused. */
  let iconsSeen = 0;

  /** The cached parse for `version`, or null when the text has changed since (or the tab closed). */
  function current(docId: string, version: number): Cached | null {
    const c = docs.get(docId);
    return c && c.version === version ? c : null;
  }

  return {
    current,

    /** True after `close` until `open`: a late parse for a closed tab is dropped, so nothing is kept for it. */
    isClosed: (docId: string) => closed.has(docId),

    open(docId: string) {
      closed.delete(docId);
    },

    close(docId: string) {
      closed.delete(docId);
      closed.add(docId);
      if (closed.size > CLOSED_KEPT) closed.delete(closed.values().next().value!);
      docs.delete(docId);
    },

    /** The text of the cached parse, for a resend; undefined when nothing is cached. */
    cachedText: (docId: string) => docs.get(docId)?.text,

    /** `keepVersion` re-parses the cached text under its own version (a resend must not look newer than a later parse). */
    parse(docId: string, text: string, keepVersion = false): FlowResult {
      const old = docs.get(docId);
      const board = parseBoard(text, { icons: iconSet, iconNear }, old && old.icons === iconsSeen ? old.board : null);
      const titles = new Set(board.frames.map((f) => f.parse.title));
      const now = soleKindTitles(board.frames);
      const before = old ? soleKindTitles(old.board.frames) : new Map<string, number>();
      const ctx: LastContext = { board, old, titles, now, before };
      const lasts = board.frames.map((_, i) => lastFor(ctx, i));
      const gone = goneAfter(ctx);
      const frames: FrameResult[] = board.frames.map((f, i) => {
        const p = f.parse;
        const last = lasts[i];
        return { index: f.index, kind: p.kind, title: p.title, from: f.from, to: f.to, line: f.line, doc: p.doc, lastValid: p.doc ? null : last, docId: idOf(p.doc), lastValidId: p.doc ? null : idOf(last), ...(p.oldEr ? { oldEr: true as const } : {}) };
      });
      const version = keepVersion && old ? old.version : nextVersion++;
      docs.set(docId, { version, text, board, lasts, gone, icons: iconsSeen });
      const top = frames[0];
      return { kind: top.kind, doc: top.doc, problems: board.problems, lastValid: top.lastValid, frames, version, ...(top.oldEr ? { oldEr: true as const } : {}) };
    },

    spans(docId: string, version: number, keys: readonly string[], names: readonly string[], frameIndex = 0): FlowSpansResult {
      const c = current(docId, version);
      if (!c) return { stale: true };
      const f = c.board.frames[frameIndex];
      // No prototype, so a name such as __proto__ is a plain key.
      const spans = Object.create(null) as Record<string, FlowSpan | null>;
      for (const k of keys) spans[k] = f ? shiftSpan(k.startsWith("row:") ? rowSpan(f.parse, k) : f.parse.span(k), f.from) : null;
      const lineOf = Object.create(null) as Record<string, number | null>;
      for (const n of names) {
        const line = f?.parse.defined.get(n);
        lineOf[n] = line === undefined ? null : line + f.line - 1;
      }
      return { stale: false, spans, lineOf };
    },

    /** The outline the diagram assistant sends and checks against, from the parse of `version`, in file lines. */
    outline(docId: string, version: number, frameIndex = 0): FlowOutlineAnswer {
      const c = current(docId, version);
      if (!c) return { stale: true };
      const f = c.board.frames[frameIndex];
      if (!f) return { stale: false, outline: { kind: null, kinds: [], nodes: [], groups: [], links: [] } };
      return { stale: false, outline: frameOutline(c, frameIndex) };
    },

    /**
     * Every frame of the parse of `version` for the board Ask, in one answer: each frame's outline (read with its own
     * text, so ER tables carry their columns) in file lines, and its problems in frame lines.
     */
    boardOutline(docId: string, version: number): BoardOutlineAnswer {
      const c = current(docId, version);
      if (!c) return { stale: true };
      const frames = c.board.frames.map((f, i): BoardOutlineFrame => {
        const p = f.parse;
        return { index: f.index, title: p.title, kind: p.kind, from: f.from, to: f.to, line: f.line, outline: frameOutline(c, i), problems: frameProblems(p.problems) };
      });
      return { stale: false, frames };
    },

    /** Runs a canvas action on one frame of the text of `version`; works while that text has errors. */
    edit(docId: string, version: number, edit: FlowRequestOp, frameIndex = 0): FlowEditAnswer {
      const c = current(docId, version);
      if (!c) return { stale: true };
      if (edit.op === "appendFrames") return { stale: false, ...appendFrames(c.text, c.board, edit.frames) };
      if (edit.op === "renameFrame") return { stale: false, ...renameFrame(c.text, c.board, edit.frameIndex, edit.title) };
      if (edit.op === "deleteFrame") return { stale: false, ...deleteFrame(c.text, c.board, edit.frameIndex) };
      if (edit.op === "duplicateFrame") return { stale: false, ...duplicateFrame(c.text, c.board, edit.frameIndex) };
      const f = c.board.frames[frameIndex];
      if (!f) return { stale: false, edits: [] };
      const r = editFrame(f, edit);
      if ((edit.op === "paste" || edit.op === "insert") && r.names && c.board.shapes + Object.keys(r.names).length > MAX_BOARD_SHAPES) {
        return { stale: false, edits: [], note: BOARD_FULL };
      }
      return { stale: false, ...r, edits: f.from === 0 ? r.edits : shiftEdits(r.edits, f.from) };
    },

    /** Every icon name, for completion after `icon:` and the unknown-icon check; an empty list checks nothing. */
    setIcons(names: readonly string[]) {
      icons = names;
      iconSet = names.length > 0 ? new Set(names) : undefined;
      iconNear.clear();
      iconsSeen++;
    },

    /**
     * Completion at `pos` in the frame holding it (a gap counts as the frame before); the cached names are used
     * when they are for this same text.
     */
    complete(docId: string, text: string, pos: number): FlowCompletionResult {
      const lineFrom = text.lastIndexOf("\n", pos - 1) + 1;
      const header = HEADER_START.exec(text.slice(lineFrom, pos));
      if (header) {
        const typed = header[1];
        return { from: pos - typed.length, items: kindItems(typed) };
      }
      const c = docs.get(docId);
      const cached = c && c.text === text ? c.board : null;
      const slices = cached ? cached.frames : splitFrames(text);
      let i = cached ? cached.frameAt(pos) : 0;
      if (!cached) while (i + 1 < slices.length && slices[i + 1].from <= pos) i++;
      const from = slices[i].from;
      // Up to the next frame, so a position in the gap after this frame is still in the text read. The last frame
      // read ends at its own end: past it (frames past MAX_BOARD_FRAMES) nothing is offered.
      const end = i + 1 < slices.length ? slices[i + 1].from : slices[i].to;
      if (pos > end) return { from: pos, items: [] };
      const own = text.slice(from, end);
      const f = cached?.frames[i];
      const r = f ? completeFlow(own, pos - from, icons, f.parse.defined, f.parse.labels, (table) => columnsOf(f.parse, own, table), f.parse.oldEr) : completeFlow(own, pos - from, icons);
      return from === 0 ? r : { from: r.from + from, items: r.items };
    },
  };
}
