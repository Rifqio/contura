// One .flow file's document: its text in CodeMirror, the worker's parse of it, the board layout file and the save.
// The whole file is one CodeMirror document with one history; the canvas sees only the selected frame's doc, layout
// and ops, as if it were the one diagram it knows. Canvas actions become text edits planned by the
// worker on one exact parse: the request names the parse's version, a stale answer is planned
// again on the next parse, and an answer is applied only if the editor still holds the very document it was planned
// on. Every edit list is one CodeMirror transaction, and a layout change is an entry of its own in the same history,
// naming its frame, so one undo covers text and canvas in any frame.
import { history, historyField, invertedEffects, isolateHistory } from "@codemirror/commands";
import { Compartment, EditorState, type Extension, StateEffect, type Text, Transaction, type TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { errorText, readDiagram, writeDiagram, writeDiagramLayout } from "../api/client";
import type { Positions } from "../diagram/layout";
import type { LangClient } from "../lang/client";
import { frameHeaders } from "../lang/flow/board";
import { type DiagramKind, FIXED_KINDS, type FlowDoc, type FlowGroup } from "../lang/flow/model";
import { type FlowSpan, parseFlow } from "../lang/flow/parse";
import type { FlowBoardOp, FlowEditAnswer, FrameResult } from "../lang/flow/service";
import type { FlowRequestOp, FlowResult, TextEdit } from "../lang/protocol";
import { adoptStraySources, type BoardLayout, type ClashLayout, type FrameLayout, type FrameSource, frameBounds, frameLayoutView, LAYOUT_SAVE_MAX, parseBoardLayout, placeNewFrame, serializeBoardLayout, TEXT_SCALE, utf8Length } from "./board/boardLayout";
import { canvasEdit, showFrame, shownRange } from "./board/frameView";
import { placeFrames } from "./board/shelf/place";
import { applySketches, freeSketchIds, invertSketchChanges, type SketchChange } from "./board/sketches";
import { layoutInput } from "./flowNodes";
import type { Point } from "./interactions/geometry";
import { type FlowHandle, type FlowHold, registerFlow, registerOrphanFailure } from "./flowRegistry";
import { axisKey, defaultDirection, emptyPositions, withoutProposed, type FlowDirection, type FlowLayout } from "./layout";
import type { NodeLook } from "./nodes/parts";

/** Saves wait this long after the last change (text or layout). */
export const SAVE_DELAY_MS = 400;
/** A canvas action is planned again at most this many times when the text keeps changing under it. */
const PLAN_TRIES = 4;
/** How long an action waits for the next parse before giving up. */
const NEXT_PARSE_MS = 2000;

/** What the save state says when the layout file would pass the Core's read limit (ruling C12). */
export const LAYOUT_TOO_BIG = "Layout not saved: the layout file would pass 5 MB. Remove some sketches.";

/**
 * The frame a layout change belongs to: its index and its layout key when the change was made. At apply time it
 * resolves by index while `keys[index]` still names that frame, else by key, following hand renames.
 */
export type FrameRef = { index: number; key: string };

/**
 * Loose sketches changed: each sketch before and after, by id. They go to the layout file only, never
 * into the text; one op is one transaction and one undo entry in the shared history.
 */
export const sketchEffect = StateEffect.define<SketchChange[]>();

/**
 * A mark on each history entry that changed the text, numbered: a frame whose text went keeps its entry while the
 * entry that took it (or, undone, brings it back on a redo) is still in the history (memory).
 */
export const goneMark = StateEffect.define<number>();

/**
 * The marks a history value (`historyField`'s) holds, undone entries included. Null when it does not read as expected
 * (a branch, or any entry's effects, of another shape after an upgrade): then nothing is pruned.
 */
export function marksIn(h: unknown): Set<number> | null {
  const v = h as { done?: unknown; undone?: unknown } | null | undefined;
  if (!v || !Array.isArray(v.done) || !Array.isArray(v.undone)) return null;
  const held = new Set<number>();
  for (const branch of [v.done, v.undone] as unknown[][])
    for (const ev of branch) {
      const effects = (ev as { effects?: unknown } | null)?.effects;
      if (!Array.isArray(effects)) return null;
      for (const e of effects as StateEffect<unknown>[]) if (e.is(goneMark)) held.add(e.value);
    }
  return held;
}

/** The marks the history still holds; null when it cannot be read (keep everything). */
const marksHeld = (state: EditorState): Set<number> | null => marksIn(state.field(historyField, false));

/** Undo and redo of sketch changes: the history holds the changes, never a copy of the board's sketches. */
export const sketchUndo: Extension = invertedEffects.of((tr) => {
  const out: StateEffect<unknown>[] = [];
  for (const e of tr.effects) if (e.is(sketchEffect)) out.push(sketchEffect.of(invertSketchChanges(e.value)));
  return out;
});

/** Node positions before and after a move; undo applies the inverse. */
export const moveEffect = StateEffect.define<{ frame: FrameRef; before: Positions; after: Positions }>();

/**
 * Step 6 (follow-up N2): the axes of + lines (by `axisKey`) before and after a canvas action, null for none. It goes in
 * the action's own transaction, so undo takes an axis back with its line and redo brings it again.
 */
export type AxisChange = Record<string, "v" | "h" | null>;
export const axisEffect = StateEffect.define<{ frame: FrameRef; before: AxisChange; after: AxisChange }>();

/** One node's box in the layout: where it is, and its kept size (null: its own size). */
export type KeptBox = { at?: { x: number; y: number }; size: { w: number; h: number } | null };
/** A resize or a Fit to content: one undo entry, so Ctrl+Z puts a manual size back. */
export const sizeEffect = StateEffect.define<{ frame: FrameRef; name: string; before: KeptBox; after: KeptBox }>();

/**
 * A frame's whole entry before and after (null: none): add, delete, duplicate, a frame move, direction, look,
 * notation and text size. `title` is the layout key, resolved through hand renames at apply time.
 */
export const frameEffect = StateEffect.define<{ title: string; before: FrameLayout | null; after: FrameLayout | null }>();

/** The selected frame: its title, and its index as a tiebreak when titles repeat. */
export type FrameSelection = { title: string; index: number };

/** The newest parse, focused on the selected frame, and the text it was made from. */
export interface Parsed {
  /** The selected frame's `kind`, `doc`, `lastValid` and `oldEr` (null, null, null, unset with nothing selected); `problems` and `frames` are the board's. */
  result: FlowResult;
  text: string;
  /** What the canvas draws for the selected frame: its doc, else its last good one (faded). Never another frame's. */
  drawn: FlowDoc | null;
  /** The line of the selected frame's first error, for the banner; null when it has none. */
  errorLine: number | null;
  /** The selected frame in this parse; null with nothing selected. */
  frame: FrameResult | null;
  /**
   * The layout key of each of this parse's frames: the keys made for the text it parsed, following hand renames made
   * since (an entry moves with its frame's rename). The board scene draws with these, never with `keys`, which run
   * ahead of the parse while a header edit waits for it.
   */
  keys: readonly string[];
}

export type SaveState = { kind: "saved" } | { kind: "waiting" } | { kind: "failed"; message: string };

export interface RunOptions {
  /** Plan only on this parse version; a newer text refuses the action instead of planning it again. */
  version?: number;
  /** Node positions written in the same transaction as the edits. */
  move?: Positions;
  /** The axes of + lines set (or, null, dropped) in the same transaction: one undo step with the edits. */
  axes?: AxisChange;
  /** Kept sizes of nodes (a shape drawn by a drag), set in the same transaction as the edits and `move`: one undo step. */
  sizes?: Record<string, { w: number; h: number }>;
  /** Loose sketches changed in the same transaction as the edits (a Delete that takes shapes and sketches): one undo step. */
  sketches?: SketchChange[];
  /** The worker refused the action and said why (a paste names the reason). */
  onRefused?(why: string): void;
  /**
   * The frame identity (`frameId`) the action started on: a gesture that awaits before it runs does nothing, quietly,
   * once another frame was selected meanwhile, so it never writes into the frame switched to.
   */
  frame?: number;
}

/** What a canvas action did: the name an add used, and where its first new line starts in the new text. */
export interface RunResult {
  name?: string;
  /** A paste: each pasted shape's name and the new name it got. */
  names?: Record<string, string>;
  /** A paste: what it left out (groups, frames). */
  note?: string;
  /** The offset of the start of the first line the edits wrote. */
  at?: number;
  /**
   * The frame the edits went to, for positions placed after the run (`place`); absent for a frame whose title an
   * earlier frame has, which keeps no positions.
   */
  frame?: FrameRef;
  /** The ids the sketches added with the edits got: picked again when one was taken while the worker planned. */
  sketchIds?: string[];
}

/**
 * Nodes an undo or redo moves: `from` where they are drawn now, `to` where they go, in the frame keyed `frame`. A
 * resize, a line's axis or a frame setting undone or redone reports its frame with no nodes moved (`from` and `to`
 * empty), so the canvas goes to that frame as it does for a move.
 */
export interface HistoryMove {
  from: Positions;
  to: Positions;
  undo: boolean;
  frame: string;
}

const KIND_LINE = /^\uFEFF?[ \t]*diagram[ \t]+(dfd|flow|cloud)\b/;

/** The diagram kind from the first line, read without a parse, so the layout defaults are right from the start. */
export function kindOfText(text: string): DiagramKind | null {
  return (KIND_LINE.exec(text)?.[1] as DiagramKind | undefined) ?? null;
}

export interface FlowDocApi {
  docId: string;
  /** The text as read from disk; null until it is. */
  initialText: string | null;
  /** Why the diagram could not be read. */
  readError: string | null;
  parsed: Parsed | null;
  /** The selected frame's layout (its kind's defaults with nothing selected). */
  layout: FlowLayout;
  /** Every frame's entry by layout key, and the sketches. */
  board: BoardLayout;
  /** The layout key of each frame index; a frame whose title an earlier frame has gets a key of its own and no entry. */
  keys: readonly string[];
  /** Layouts of the frames whose title an earlier frame has, by frame index: laid out for drawing only, never saved. */
  clashLayouts: ReadonlyMap<number, ClashLayout>;
  selected: FrameSelection | null;
  /**
   * The selected frame's identity: it changes when another frame is selected (or none), never when the selected
   * frame is renamed or moves in the text, so per-frame state resets on a real switch only (Figma keeps the selection
   * on a page rename).
   */
  frameId: number;
  select(sel: FrameSelection | null): void;
  /** The selection as it is now, before a render shows it (an update listener reads it). */
  selection(): FrameSelection | null;
  /** `frameId` as it is now, for an action to take at its start (`RunOptions.frame`). */
  frameIdNow(): number;
  /** A canvas write (`run`, `frameOp`, `addFrames`) or the parse it plans on (`current`) is under way. */
  busy(): boolean;
  save: SaveState;
  /** The editor's extensions for this document: the history, the layout entries and the change listener. */
  extensions: Extension[];
  /** The editor view, once the editor made it. */
  attach(view: EditorView | null): void;
  view(): EditorView | null;
  /**
   * A canvas action on the selected frame as text edits: resolves to the name an add used, or null when it does not
   * apply (or nothing is selected). With `version` it is planned on that parse only and never planned again on a newer
   * text (an action that names a link by its index). `move` goes in the same transaction, so the text change and the
   * move are one undo entry.
   */
  run(op: FlowRequestOp, opts?: RunOptions): Promise<RunResult | null>;
  /** Spans of `keys` in the selected frame of parse `version`; null when that is no longer the current text. */
  spans(version: number, keys: string[]): Promise<Record<string, FlowSpan | null> | null>;
  /** The edits a canvas action would make to the current text, without making them; null when it does not apply. */
  plan(op: FlowRequestOp): Promise<{ edits: TextEdit[]; text: string } | null>;
  /** The parse of the text the editor holds now, once it has arrived; null when it does not (closed, or a timeout). */
  current(): Promise<Parsed | null>;
  /** Called when undo or redo moves nodes: where they are and where they go (moves share the history). */
  onHistoryMove(fn: (move: HistoryMove) => void): () => void;
  /** Applies a fix's edits when the text is still the one its parse was made from. */
  applyFix(edits: TextEdit[], parsedText: string): boolean;
  /**
   * One move in the selected frame, one undo entry; `before` when the nodes were already drawn moved (a held arrow
   * key's burst). `sketches` moved with the shapes go in the same transaction; a diagram frame never moves sketches.
   * `frame` moves another frame's nodes (the only frame dragged by its tab while it is not selected).
   */
  move(after: Positions, before?: Positions, sketches?: SketchChange[], frame?: FrameRef): void;
  /** Loose sketches added, changed or deleted (the ops in `board/sketches.ts`), as one undo entry; the layout file only. */
  sketch(changes: SketchChange[]): void;
  /**
   * Positions for nodes that had none (placed by the layout engine, or a node just added); not an undo entry.
   * `override` replaces kept ones. `frame` (a run's `RunResult.frame`) names the frame they belong to: when it no longer
   * names a frame, or is null, nothing is written. Without it they go to the selected frame.
   */
  place(positions: Positions, override?: boolean, frame?: FrameRef | null): void;
  /** Positions for nodes of the frame keyed `key` that had none, outside the history. */
  placeIn(key: string, positions: Positions): void;
  /**
   * Positions for shapes the assistant's waiting changes draw over the drawing: kept until the changes are decided,
   * then `settleProposed` drops the ones the text does not have.
   */
  placeProposed(positions: Positions): void;
  /** The waiting changes are decided and `names` is what the text defines now: positions of proposed shapes it lacks go. */
  settleProposed(names: ReadonlySet<string> | ReadonlyMap<string, unknown>): void;
  /**
   * `placeProposed` for the frame keyed `key` (any frame a board review touches), outside the history:
   * the positions it had none for are kept until `settleProposedIn` for that key.
   */
  placeProposedIn(key: string, positions: Positions): void;
  /** `settleProposed` for the frame keyed `key`: positions of its proposed shapes that `names` lacks go, outside the history. */
  settleProposedIn(key: string, names: ReadonlySet<string> | ReadonlyMap<string, unknown>): void;
  /** How many frames hold proposed places, for the memory tests. */
  proposedSize(): number;
  /** The selected frame's look, as an undo entry. */
  setStyle(style: NodeLook): void;
  /** The selected frame's direction, as an undo entry. */
  setDirection(direction: FlowDirection): void;
  /**
   * Round 2, N-B: drops the axes of lines the text no longer has (typed away), outside the history, so a line drawn
   * again between the same shapes starts with none.
   */
  dropAxes(keys: readonly string[]): void;
  /** Item 21: a node resized on the canvas: its new box (a left or top handle moves it too); kept in the layout file. */
  resize(name: string, box: { x: number; y: number; w: number; h: number }): void;
  /** A resized node goes back to its own size (Fit to content, a double-click on its edge). */
  unsize(name: string): void;
  /** A board op (add, rename, duplicate, delete) with its entry change in the same transaction: one undo entry. `at` places an added or duplicated frame. */
  frameOp(op: FlowBoardOp, at?: { x: number; y: number }, onRefused?: (why: string) => void): Promise<RunResult | null>;
  /**
   * Frames added from text (the Shelf, B2 decision 8): each laid out and measured first, placed in one row centred on
   * `centre` (board coordinates) so its drawn box lands on its slot, then written as one undo entry with titles made
   * free. Answers the titles used and the boxes (board coordinates), or why nothing was added: the refusal's note, or
   * "" when nothing could be written for no reason to show (the tab closed, the text kept changing). Never selects.
   */
  addFrames(frames: readonly NewFrame[], centre: Point): Promise<{ titles: string[]; boxes: Rect[] } | { refused: string }>;
  /**
   * `measureNewFrames` for a landing: each frame laid out and measured and placed in one row on
   * `centre`, its entry under the title `appendFrames` will write for it (`titles[i]` for `frames[i]`). Writes nothing.
   * A review's `proposedAt` and the entries `landBoard` takes must come from the same call, so a frame lands where it
   * was previewed.
   */
  prepareFrames(frames: readonly NewFrame[], titles: readonly string[], centre: Point): Promise<LandedFrames>;
  /** Moves a frame's origin, as one undo entry. */
  moveFrame(key: string, at: { x: number; y: number }): void;
  /**
   * A frame's own settings, as one undo entry. Medium text and crow's feet are the defaults and are not kept, so a
   * one-frame file set back to them is written as version 1 again.
   */
  setFrameSetting(key: string, patch: Partial<Pick<FrameLayout, "direction" | "style" | "notation" | "textSize">>): void;
  /** The 1-based line each name is defined on in the current text, or null when the text has changed since. */
  linesOf(names: string[]): Promise<Record<string, number | null> | null>;
  /** Parses the editor's text again, as when the worker learns something new (the icon names). */
  reparse(): void;
  /** Writes until nothing is due; true once the files on disk hold what the tab holds. */
  flush(): Promise<boolean>;
  /** Holds writes (and the text read-only with `readOnly`) until the returned release is called. */
  hold(opts?: { readOnly?: boolean }): FlowHold;
  /**
   * Edits planned elsewhere on the text of parse `version` (the diagram assistant's landing), as one transaction and
   * one undo entry. False, with nothing changed, when the editor no longer holds that version's text.
   */
  land(edits: TextEdit[], version: number): boolean;
  /**
   * `land` for a landing that adds frames: the same transaction also writes `adds`' entries (from `prepareFrames`), so
   * one undo takes back the edits and the frames and a redo gives both back without a layout pass. False, with nothing
   * changed, when the editor no longer holds that version's text.
   */
  landBoard(edits: TextEdit[], version: number, adds: readonly NewEntry[]): boolean;
  /**
   * Reads the file again and puts its text in the editor, as what the tab holds and what is on disk (the assistant's
   * "Ask again on the current text"). False, with nothing changed, when it could not be read.
   */
  reload(): Promise<boolean>;
}

/** What one save writes: the layout file always, the text only when `textEdited`. */
interface Payload {
  text: string;
  textEdited: boolean;
  layout: string;
  edited: number;
  /** The layout would pass LAYOUT_SAVE_MAX: `layout` is the last one saved instead. */
  over: boolean;
}

/** A move, Classic or the direction writes only the layout file; the .flow is written after a text edit only. */
function writeFiles(name: string, p: Payload): Promise<void> {
  return p.textEdited ? writeDiagram(name, p.text, p.layout, true) : writeDiagramLayout(name, p.layout);
}

/** True for a text whose every line break is CRLF: it is saved with CRLF again after an edit. */
function isCrlf(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

type Head = { kind: DiagramKind | null; title: string; from: number };

/** Each document's frame headers, read once per document. */
const headCache = new WeakMap<Text, Head[]>();
/**
 * `doc`'s frame headers, read once per document (`text` is its string when the caller has it): the keys and the code
 * pane's frame following share one scan per keystroke.
 */
export function frameHeadsOf(doc: Text, text?: string): Head[] {
  let heads = headCache.get(doc);
  if (!heads) headCache.set(doc, (heads = frameHeaders(text ?? doc.toString())));
  return heads;
}

/** The key of a frame whose title an earlier frame has: drawn faded, never live, and no entry is written. */
const dupKey = (index: number) => `\u0000#${index}`;
/** A layout key held for a frame whose title another frame has. */
export const isDup = (key: string) => key.startsWith("\u0000#");

/** Every group name in `groups`, at any depth. */
function groupNames(groups: readonly FlowGroup[]): string[] {
  return groups.flatMap((g) => [g.name, ...groupNames(g.groups)]);
}

/** Keys from titles: the first frame with a title owns it. */
function keysFromTitles(heads: readonly Head[]): string[] {
  const seen = new Set<string>();
  return heads.map((h, i) => {
    if (seen.has(h.title)) return dupKey(i);
    seen.add(h.title);
    return h.title;
  });
}

/** The selected frame's index among `titles`: by index while its title still matches, else the first with the title. */
function frameIndexOf(sel: FrameSelection | null, titles: readonly string[]): number | null {
  if (!sel) return null;
  if (titles[sel.index] === sel.title) return sel.index;
  const i = titles.indexOf(sel.title);
  return i < 0 ? null : i;
}

const isBoardOp = (op: FlowRequestOp): op is FlowBoardOp =>
  op.op === "appendFrames" || op.op === "renameFrame" || op.op === "deleteFrame" || op.op === "duplicateFrame";

/** A parse as the worker posted it, with each frame's drawn doc. */
interface Raw {
  result: FlowResult;
  text: string;
  /** Each frame's doc, else its own last good one (the worker's `lastValid`). */
  drawns: (FlowDoc | null)[];
  /** The keys when this text was sent to be parsed: they name its frames, index for index. */
  keys: readonly string[];
}

/** The parse as the canvas sees it: focused on the selected frame. */
function focus(raw: Raw, sel: FrameSelection | null, keys: readonly string[]): Parsed {
  const frames = raw.result.frames;
  const i = frameIndexOf(
    sel,
    frames.map((f) => f.title),
  );
  const f = i === null ? null : frames[i];
  const result: FlowResult = {
    kind: f?.kind ?? null,
    doc: f?.doc ?? null,
    problems: raw.result.problems,
    lastValid: f?.lastValid ?? null,
    frames,
    version: raw.result.version,
    ...(f?.oldEr ? { oldEr: true as const } : {}),
  };
  let errorLine: number | null = null;
  if (f && i !== null && !f.doc) {
    const end = i + 1 < frames.length ? frames[i + 1].from : Number.POSITIVE_INFINITY;
    errorLine = raw.result.problems.find((p) => p.severity === "error" && p.from >= f.from && p.from < end)?.line ?? null;
  }
  return { result, text: raw.text, drawn: f && i !== null ? raw.drawns[i] : null, errorLine, frame: f, keys };
}

function newEntry(kind: DiagramKind | null, at: { x: number; y: number }): FrameLayout {
  return { at, nodes: emptyPositions(), style: "modern", direction: defaultDirection(kind) };
}

/** A copy that shares no object with `e`. */
function cloneEntry(e: FrameLayout): FrameLayout {
  const out: FrameLayout = { ...e, at: { ...e.at }, nodes: Object.assign(emptyPositions(), e.nodes) };
  if (e.sizes) out.sizes = Object.assign(Object.create(null) as Record<string, { w: number; h: number }>, e.sizes);
  if (e.axes) out.axes = Object.assign(Object.create(null) as Record<string, "v" | "h">, e.axes);
  return out;
}

/** A frame an add writes: its title as the text has it and its entry. */
export type NewEntry = { title: string; after: FrameLayout };

/**
 * The add transaction, shared by `frameOp`'s add path and `addFrames`: the text edits, one entry change per
 * added frame (its `before` is the entry the title has now, a gone frame's kept one included, so undo gives it back),
 * the shown block kept to its own end, and one undo entry.
 */
export function frameAddSpec(state: EditorState, edits: readonly TextEdit[], adds: readonly NewEntry[], board: BoardLayout): TransactionSpec {
  const changes = state.changes(edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })));
  const effects: StateEffect<unknown>[] = adds.map((a) => frameEffect.of({ title: a.title, before: board.frames.get(a.title) ?? null, after: a.after }));
  // A frame appended at the shown frame's end is not part of it: the shown block keeps its own end.
  const shown = shownRange(state);
  if (shown) {
    const from = changes.mapPos(shown.from, 1);
    effects.push(showFrame.of({ from, to: Math.max(from, changes.mapPos(shown.to, -1)), line: changes.apply(state.doc).lineAt(from).number }));
  }
  return { changes, effects, userEvent: "input.canvas", annotations: [isolateHistory.of("full"), canvasEdit.of(true)] };
}

/** A box in board coordinates. */
export type Rect = { x: number; y: number; w: number; h: number };

/** A frame to add from its text (B2 decision 8); `direction` replaces the kind's default. */
export interface NewFrame {
  text: string;
  direction?: FlowDirection;
  /** The Connection From my database drew it from: kept on its entry, never in the text. */
  source?: FrameSource;
}

/**
 * Decision 8, the main thread's part of `addFrames`: each text parsed here, its entry made with `newEntry` and its
 * nodes laid out by `layout` (a kind that places itself is not), its drawn box measured with `frameBounds`, the boxes
 * placed in one row centred on `centre`, and each entry's origin set so its drawn box, not its origin, lands on its
 * slot (R1). `boxes` are those slots with the measured sizes, in board coordinates.
 */
export async function measureNewFrames(
  frames: readonly NewFrame[],
  centre: Point,
  layout: (doc: FlowDoc, e: FrameLayout) => Promise<Positions>,
): Promise<{ entries: FrameLayout[]; boxes: Rect[] }> {
  const made: { entry: FrameLayout; box: Rect }[] = [];
  for (const f of frames) {
    const doc = parseFlow(f.text).doc;
    const kind = doc?.kind ?? frameHeaders(f.text)[0]?.kind ?? null;
    let entry = newEntry(kind, { x: 0, y: 0 });
    if (f.direction) entry.direction = f.direction;
    if (f.source) entry.source = { ...f.source };
    if (doc && !FIXED_KINDS.has(doc.kind) && doc.nodes.length > 0) entry = { ...entry, nodes: Object.assign(emptyPositions(), await layout(doc, entry)) };
    made.push({ entry, box: frameBounds(entry, doc, entry.style) });
  }
  const slots = placeFrames(
    made.map((m) => m.box),
    centre,
  );
  const entries = made.map(({ entry, box }, i) => ({ ...entry, at: { x: slots[i].x - (box.x - entry.at.x), y: slots[i].y - (box.y - entry.at.y) } }));
  const boxes = made.map(({ box }, i) => ({ x: slots[i].x, y: slots[i].y, w: box.w, h: box.h }));
  return { entries, boxes };
}

/** What `prepareFrames` answers: the entries a landing writes and the boxes (board coordinates) they were placed on. */
export interface LandedFrames {
  entries: NewEntry[];
  boxes: Rect[];
}

/** `e` with only the positions, sizes and axes of what `doc` has (an empty group keeps its place, diag-910 I5). */
function pruned(e: FrameLayout, doc: FlowDoc): FrameLayout {
  const nodes = emptyPositions();
  for (const n of doc.nodes) if (own(e.nodes, n.name)) nodes[n.name] = e.nodes[n.name];
  const walk = [...doc.groups];
  for (let g = walk.pop(); g; g = walk.pop()) {
    if (own(e.nodes, g.name)) nodes[g.name] = e.nodes[g.name];
    walk.push(...g.groups);
  }
  const out: FrameLayout = { ...e, nodes };
  if (e.sizes) {
    const kept: Record<string, { w: number; h: number }> = {};
    for (const n of doc.nodes) if (own(e.sizes, n.name)) kept[n.name] = e.sizes[n.name];
    out.sizes = kept;
  }
  if (e.axes) {
    const live = new Set(doc.links.map((k) => axisKey(k.from, k.to)));
    const kept: Record<string, "v" | "h"> = {};
    for (const [k, v] of Object.entries(e.axes)) if (live.has(k)) kept[k] = v;
    out.axes = kept;
  }
  return out;
}

const SETTINGS = ["at", "style", "direction", "notation", "textSize"] as const;

/** `now` with each setting `before` and `after` differ on set as `after` has it. */
function patchSettings(now: FrameLayout, before: FrameLayout, after: FrameLayout): FrameLayout {
  const out: FrameLayout = { ...now };
  const o = out as unknown as Record<string, unknown>;
  for (const k of SETTINGS) {
    if (JSON.stringify(before[k]) === JSON.stringify(after[k])) continue;
    if (after[k] === undefined) delete o[k];
    else o[k] = after[k];
  }
  return out;
}

/** A short fingerprint of a frame's lines (their length and FNV-1a hash), kept in place of the lines themselves. */
function fingerprint(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

/** How many hand renames are remembered for effects still in the history. */
const RENAMES_KEPT = 256;

export function useFlowDoc(name: string, client: LangClient): FlowDocApi {
  const docId = `flow:${name}`;
  const [initialText, setInitialText] = useState<string | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [raw, setRaw] = useState<Raw | null>(null);
  const [board, setBoardState] = useState<BoardLayout>(() => ({ frames: new Map(), sketches: [] }));
  const [keys, setKeysState] = useState<readonly string[]>([]);
  const [selected, setSelected] = useState<FrameSelection | null>(null);
  const [frameId, setFrameId] = useState(0);
  /** `frameId` now, before a render shows it. */
  const frameIdRef = useRef(0);
  const [clashLayouts, setClashState] = useState<ReadonlyMap<number, ClashLayout>>(() => new Map());
  const clashRef = useRef<ReadonlyMap<number, ClashLayout>>(clashLayouts);
  const setClash = useCallback((next: ReadonlyMap<number, ClashLayout>) => {
    clashRef.current = next;
    setClashState(next);
  }, []);
  const [save, setSaveState] = useState<SaveState>({ kind: "saved" });

  const viewRef = useRef<EditorView | null>(null);
  const boardRef = useRef(board);
  /** Each frame's layout key and header, updated on every document change, before any parse. */
  const keysRef = useRef<string[]>([]);
  const headsRef = useRef<Head[]>([]);
  /** The text `headsRef` was read from: a frame's lines tell which frame it was when titles repeat. */
  const headsText = useRef("");
  const selRef = useRef<FrameSelection | null>(null);
  /** Hand renames, old key to new: an effect made before one still finds its frame. */
  const renamed = useRef(new Map<string, string>());
  /** The layout file as read or last written; written again in place of one past LAYOUT_SAVE_MAX (ruling C12). */
  const lastSaved = useRef<string | null>(null);
  /** The editor's text (LF), for a save after the view is gone. */
  const textRef = useRef<string | null>(null);
  /** The file's text as it was read or last saved; a save writes the text only after a text edit. */
  const diskText = useRef<string | null>(null);
  /** Counts text edits; while it equals the count at the last text save, a save writes only the layout file. */
  const edits = useRef(0);
  const savedEdits = useRef(0);
  const crlf = useRef(false);
  /** The newest parse, with the number of the call whose text it was made from. */
  const parsedRef = useRef<(Raw & { call: number }) | null>(null);
  const calls = useRef(0);
  /** Actions waiting for the next parse; closing the tab lets them go at once. */
  const waiters = useRef(new Map<() => void, () => void>());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveSeq = useRef(0);
  const saveRef = useRef<SaveState>(save);
  const alive = useRef(true);
  /** This tab's entry in the window's list; updates after it closed go nowhere. */
  const handle = useRef<FlowHandle | null>(null);
  /** The user chose Discard: nothing more is written for this tab. */
  const discarded = useRef(false);
  const historyMoves = useRef(new Set<(move: HistoryMove) => void>());
  /** Writes are held (a delete or rename of the file is on its way); a save that comes due waits for the release. */
  const held = useRef(0);
  const dueWhileHeld = useRef(false);
  /** What a tab that closed while held still has to write; written on the release. */
  const deferred = useRef<Payload | null>(null);
  /** The writes on their way; a hold settles once every one has landed. */
  const inflight = useRef(new Set<Promise<boolean>>());
  /** Read-only while a rename runs. */
  const readOnlyRef = useRef(new Compartment());
  /** The open document's flush and hold, made with its registry entry. */
  const control = useRef<{ flush(): Promise<boolean>; hold(opts?: { readOnly?: boolean }): FlowHold } | null>(null);
  /** Frames being placed; a parse meanwhile places again after. */
  const placing = useRef(false);
  const placeAgain = useRef(false);
  /** Entries placed by Decision 10 and not changed by hand since: a stand-in a returning title may replace. */
  const minted = useRef(new Set<string>());
  /** The key a frame had when its text went, by its title: an undo that brings it back finds its own entry. */
  const goneKeys = useRef(new Map<string, string>());
  /** The same keys by the gone frame's lines (their fingerprint): an undo that brings a frame back under a title another frame has. */
  const goneByLines = useRef(new Map<string, string[]>());
  /** Keys of frames whose text went, with the history mark of the change that took it (null: outside the history). */
  const goneAt = useRef(new Map<string, number | null>());
  /** Each text change's history mark, for the keys it takes away. */
  const marks = useRef(new WeakMap<Transaction, number>());
  const markSeq = useRef(0);

  const setBoard = useCallback((next: BoardLayout) => {
    boardRef.current = next;
    setBoardState(next);
  }, []);

  const setKeys = useCallback((next: string[]) => {
    keysRef.current = next;
    setKeysState(next);
  }, []);

  /** Another frame (or none) selected: a new identity. */
  const select = useCallback((sel: FrameSelection | null) => {
    const was = selRef.current;
    selRef.current = sel;
    setSelected(sel);
    if (!(was === sel || (was && sel && was.index === sel.index && was.title === sel.title))) setFrameId(++frameIdRef.current);
  }, []);
  /** The selected frame followed through a rename or a move in the text: the same identity. */
  const follow = useCallback((sel: FrameSelection) => {
    selRef.current = sel;
    setSelected(sel);
  }, []);

  const setSave = useCallback(
    (next: SaveState) => {
      saveRef.current = next;
      if (alive.current) setSaveState(next);
      handle.current?.update({ save: next.kind, message: next.kind === "failed" ? next.message : undefined });
    },
    [name],
  );

  /** The selected frame by the current headers; null with nothing selected or on a frame that has no entry of its own. */
  const selFrame = useCallback((): FrameRef | null => {
    const i = frameIndexOf(
      selRef.current,
      headsRef.current.map((h) => h.title),
    );
    if (i === null) return null;
    const key = keysRef.current[i];
    return key === undefined || isDup(key) ? null : { index: i, key };
  }, []);

  /** The key a change made in `ref` lands in now. */
  const resolveKey = useCallback((ref: FrameRef): string => {
    if (keysRef.current[ref.index] === ref.key) return ref.key;
    let k = ref.key;
    for (let n = 0; n < RENAMES_KEPT; n++) {
      const next = renamed.current.get(k);
      if (next === undefined || next === k) break;
      k = next;
    }
    return k;
  }, []);

  /** A parse's keys, each followed through the hand renames made since, while its entry moved and the key is free. */
  const parseKeys = useCallback((at: readonly string[]): readonly string[] => {
    const b = boardRef.current.frames;
    let out: string[] | null = null;
    at.forEach((k, i) => {
      if (isDup(k) || b.has(k)) return;
      let n = k;
      for (let c = 0; c < RENAMES_KEPT; c++) {
        const next = renamed.current.get(n);
        if (next === undefined || next === n) break;
        n = next;
      }
      if (n === k || !b.has(n) || at.includes(n) || out?.includes(n)) return;
      out ??= at.slice();
      out[i] = n;
    });
    return out ?? at;
  }, []);
  const kindOfKey = useCallback((key: string) => headsRef.current[keysRef.current.indexOf(key)]?.kind ?? null, []);

  /** The drawn doc of frame `i` of the newest parse, when that parse's frame `i` is the same frame as the headers'. */
  const drawnAt = useCallback((i: number): FlowDoc | null => {
    const r = parsedRef.current;
    return r && r.result.frames[i]?.title === headsRef.current[i]?.title ? (r.drawns[i] ?? null) : null;
  }, []);

  /** The boxes of every frame that has an entry or a clash layout, in board coordinates. */
  const frameBoxes = useCallback(() => {
    const out: { x: number; y: number; w: number; h: number }[] = [];
    const b = boardRef.current;
    keysRef.current.forEach((k, i) => {
      if (isDup(k)) {
        const c = clashRef.current.get(i);
        if (c && c.title === headsRef.current[i]?.title) out.push(frameBounds(c.entry, drawnAt(i), c.entry.style, true));
        return;
      }
      const e = b.frames.get(k);
      if (e) out.push(frameBounds(e, drawnAt(i), e.style));
    });
    return out;
  }, [drawnAt]);

  /** A new frame's entry, placed beside the board. */
  const placedEntry = useCallback((kind: DiagramKind | null) => newEntry(kind, placeNewFrame(frameBoxes())), [frameBoxes]);

  /** Sets (or, null, removes) one entry outside the history. */
  const setEntry = useCallback(
    (key: string, e: FrameLayout | null) => {
      const b = boardRef.current;
      const frames = new Map(b.frames);
      if (e) frames.set(key, e);
      else frames.delete(key);
      setBoard({ ...b, frames });
    },
    [setBoard],
  );

  /** Changes one entry (made, placed, when it has none). */
  const editEntry = useCallback(
    (key: string, fn: (e: FrameLayout) => FrameLayout) => {
      setEntry(key, fn(boardRef.current.frames.get(key) ?? placedEntry(kindOfKey(key))));
    },
    [setEntry, placedEntry, kindOfKey],
  );

  /** What a save writes now: the layout file, and the text when it was edited since; null before the file was read. */
  const payload = useCallback((): Payload | null => {
    const edited = edits.current;
    const current = viewRef.current?.state.doc.toString() ?? textRef.current;
    // Not edited since it was read or saved: the text is what the file had (Save a copy as copies it), and a save
    // leaves the .flow alone, so an edit made outside Contura meanwhile survives a move.
    const textEdited = edited !== savedEdits.current;
    const text = !textEdited ? diskText.current : current !== null && crlf.current ? current.replace(/\n/g, "\r\n") : current;
    if (text === null) return null;
    const b = boardRef.current;
    const ks = keysRef.current;
    const heads = headsRef.current;
    // While a header fails to read, or the board has any error (a bad kind word, a repeated title), every entry is
    // kept in the file: gone titles are pruned only on a parse of this text with no errors.
    const cur = parsedRef.current;
    const aligned = cur !== null && cur.text === current;
    const keepAll = heads.some((h) => h.kind === null) || !aligned || cur.result.problems.some((p) => p.severity === "error");
    // A clean frame leaves out positions of names its text no longer has (memory keeps them for undo); a frame with an
    // error keeps every position. The doc is found by the frame's title, never by index.
    const docs = new Map<string, FlowDoc | null>();
    if (aligned) for (const f of cur.result.frames) docs.set(f.title, docs.has(f.title) ? null : f.doc);
    const count = new Map<string, number>();
    for (const h of heads) count.set(h.title, (count.get(h.title) ?? 0) + 1);
    // Each name in the file reopens as the frame titled with it, so a name goes only to that frame's own entry:
    // (a) a frame keyed by its title; (b) a frame held under an old key, under its title when no entry is kept under
    // it, else under its key unless another frame is titled so; (c) while every entry is kept, an entry no frame has,
    // under its key (ruling: a kept entry is never replaced in the file while the board has an error). Any other entry
    // stays in memory only.
    const file = new Map<string, FrameLayout>();
    const names = new Set<string>();
    const kinds = new Map<string, DiagramKind | null>();
    const titled = (name: string) => count.has(name);
    const put = (name: string, e: FrameLayout | undefined, kind: DiagramKind | null, title: string | null) => {
      names.add(name);
      kinds.set(name, kind);
      if (!e) return;
      const doc = title !== null && count.get(title) === 1 ? docs.get(title) : null;
      file.set(name, doc ? pruned(e, doc) : e);
    };
    ks.forEach((k, i) => {
      if (!isDup(k) && k === heads[i]?.title) put(k, b.frames.get(k), heads[i].kind, k);
    });
    ks.forEach((k, i) => {
      const h = heads[i];
      if (isDup(k) || h === undefined || k === h.title) return;
      // A gone frame's entry under the title is in the file only while every entry is kept.
      const kept = keepAll && b.frames.has(h.title) && !ks.includes(h.title);
      if (count.get(h.title) === 1 && !names.has(h.title) && !kept) put(h.title, b.frames.get(k), h.kind, h.title);
      else if (!names.has(k) && !titled(k)) put(k, b.frames.get(k), h.kind, null);
    });
    if (keepAll) for (const [k, e] of b.frames) if (!ks.includes(k) && !names.has(k)) put(k, e, null, null);
    let layout = serializeBoardLayout({ ...b, frames: file }, names, keepAll, kinds);
    // UTF-8 is at most 3 bytes a UTF-16 unit: only a long file is measured.
    const over = layout.length * 3 > LAYOUT_SAVE_MAX && utf8Length(layout) > LAYOUT_SAVE_MAX;
    if (over) layout = lastSaved.current ?? serializeBoardLayout({ frames: new Map(), sketches: [] }, names, keepAll, kinds);
    return { text, textEdited, layout, edited, over };
  }, []);

  /** Writes the layout now, with the text when it was edited; true once it is on disk. */
  const writeNow = useCallback((): Promise<boolean> => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (discarded.current) return Promise.resolve(true);
    if (held.current > 0) {
      dueWhileHeld.current = true;
      return Promise.resolve(false);
    }
    const p = payload();
    if (p === null) return Promise.resolve(false);
    const { text, edited } = p;
    const seq = ++saveSeq.current;
    const write = writeFiles(name, p).then(
      () => {
        if (p.textEdited) {
          diskText.current = text;
          savedEdits.current = edited;
        }
        if (!p.over) lastSaved.current = p.layout;
        // The text is on disk; the layout that would not fit is not, and the save state says so (ruling C12).
        if (seq === saveSeq.current && !saveTimer.current) setSave(p.over ? { kind: "failed", message: LAYOUT_TOO_BIG } : { kind: "saved" });
        return !p.over;
      },
      (e) => {
        if (seq === saveSeq.current) setSave({ kind: "failed", message: errorText(e) });
        return false;
      },
    );
    inflight.current.add(write);
    void write.then(() => {
      inflight.current.delete(write);
    });
    return write;
  }, [name, setSave, payload]);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = null;
    if (discarded.current) return;
    if (held.current > 0) dueWhileHeld.current = true;
    else saveTimer.current = setTimeout(() => void writeNow(), SAVE_DELAY_MS);
    setSave({ kind: "waiting" });
  }, [writeNow, setSave]);

  /** Positions for `doc`'s nodes `e` has none for, by today's dagre call (FlowTab's own placement for the live frame). */
  const layoutNodes = useCallback(
    async (doc: FlowDoc, e: FrameLayout): Promise<Positions> => {
      // At the frame's own text size, as FlowTab lays out the live frame: a Large frame's shapes never overlap.
      const input = layoutInput(doc, e.style, TEXT_SCALE[e.textSize ?? "m"]);
      const existing = emptyPositions();
      for (const n of doc.nodes) if (own(e.nodes, n.name)) existing[n.name] = e.nodes[n.name];
      let p: Positions | null = null;
      try {
        p = await client.layout({ ...input, existing, rankdir: e.direction });
      } catch {
        p = null;
      }
      const out = emptyPositions();
      const below = Object.values(existing).reduce((y, q) => Math.max(y, q.y), 0) + 200;
      let x = 0;
      for (const n of input.nodes) {
        if (own(e.nodes, n.id)) continue;
        const q = p && own(p, n.id) ? p[n.id] : null;
        if (q && Number.isFinite(q.x) && Number.isFinite(q.y)) out[n.id] = { x: q.x, y: q.y };
        else {
          out[n.id] = { x, y: below };
          x += n.w + 40;
        }
      }
      return out;
    },
    [client],
  );

  /** Fills in positions of `key`'s entry that it has none for, outside the history. */
  const placeIn = useCallback(
    (key: string, positions: Positions) => {
      if (isDup(key)) return;
      editEntry(key, (e) => {
        const nodes = emptyPositions();
        Object.assign(nodes, positions, e.nodes);
        return { ...e, nodes };
      });
    },
    [editEntry],
  );

  /**
   * Each frame with no entry is placed beside the others in text order, outside the history; the nodes
   * of frames other than the selected one (FlowTab places those) that have no position are laid out first, so the
   * placed box holds them.
   */
  const placeFrames = useCallback(() => {
    if (placing.current) {
      placeAgain.current = true;
      return;
    }
    const cur = parsedRef.current;
    const view = viewRef.current;
    if (!cur || !alive.current || (view && cur.text !== view.state.doc.toString())) return;
    placing.current = true;
    void (async () => {
      try {
        const frames = cur.result.frames;
        // A clash layout goes once its frame's title is its own again (or the frame is gone).
        // A clash index past the frames now (a frame deleted) has no key: that layout goes too.
        const kept = new Map(
          [...clashRef.current].filter(([i, c]) => {
            const k = keysRef.current[i];
            return k !== undefined && isDup(k) && headsRef.current[i]?.title === c.title;
          }),
        );
        if (kept.size !== clashRef.current.size) setClash(kept);
        for (let i = 0; i < frames.length; i++) {
          if (!alive.current) return;
          // A newer parse, or an edit not parsed yet, may have moved the frames: place again on the next parse.
          const v = viewRef.current;
          if (parsedRef.current !== cur || (v && cur.text !== v.state.doc.toString())) {
            placeAgain.current = parsedRef.current !== cur;
            return;
          }
          const key = keysRef.current[i];
          if (key === undefined) continue;
          if (isDup(key)) {
            // A frame whose title an earlier frame has is drawn faded and has no entry. It is laid out as
            // a frame without an entry is, for drawing only: kept in memory by index, never saved.
            const doc = cur.drawns[i];
            const title = headsRef.current[i]?.title;
            if (!doc || title === undefined || frames[i].title !== title) continue;
            const had = clashRef.current.get(i);
            const fits = had?.title === title ? had : undefined;
            const base = fits?.entry ?? newEntry(frames[i].kind, { x: 0, y: 0 });
            const unplaced = !FIXED_KINDS.has(doc.kind) && doc.nodes.some((n) => !own(base.nodes, n.name));
            const names = new Set(doc.nodes.map((n) => n.name));
            const stale = Object.keys(base.nodes).some((k) => !names.has(k));
            if (fits && !unplaced && !stale) continue;
            const nodes = unplaced ? await layoutNodes(doc, base) : null;
            const after = viewRef.current;
            if (!alive.current || keysRef.current[i] !== key || parsedRef.current !== cur || (after && cur.text !== after.state.doc.toString())) continue;
            const entry: FrameLayout = fits ? { ...base } : { ...base, at: placeNewFrame(frameBoxes()) };
            // Only the frame's own names: a name typed letter by letter leaves no place behind for each prefix.
            const ownNames = emptyPositions();
            for (const n of doc.nodes) if (own(base.nodes, n.name)) ownNames[n.name] = base.nodes[n.name];
            if (nodes || stale) entry.nodes = Object.assign(ownNames, nodes);
            setClash(new Map(clashRef.current).set(i, { title, entry }));
            continue;
          }
          const had = boardRef.current.frames.get(key);
          // A header that does not read makes no entry: one made now could later stand in for the frame's real one.
          if (!had && headsRef.current[i]?.kind == null) continue;
          const base = had ?? newEntry(frames[i].kind, { x: 0, y: 0 });
          const doc = cur.drawns[i];
          const live = frameIndexOf(
            selRef.current,
            headsRef.current.map((h) => h.title),
          );
          const unplaced = i !== live && doc !== null && !FIXED_KINDS.has(doc.kind) && doc.nodes.some((n) => !own(base.nodes, n.name));
          if (had && !unplaced) continue;
          const nodes = unplaced && doc ? await layoutNodes(doc, base) : null;
          const after = viewRef.current;
          if (!alive.current || keysRef.current[i] !== key || parsedRef.current !== cur || (after && cur.text !== after.state.doc.toString())) continue;
          const now = boardRef.current.frames.get(key);
          if (now) {
            if (nodes) placeIn(key, nodes);
            continue;
          }
          const entry = { ...base, at: placeNewFrame(frameBoxes()) };
          if (nodes) entry.nodes = Object.assign(emptyPositions(), nodes, base.nodes);
          setEntry(key, entry);
          minted.current.add(key);
        }
      } finally {
        placing.current = false;
        if (placeAgain.current && alive.current) {
          placeAgain.current = false;
          placeFrames();
        }
      }
    })();
  }, [layoutNodes, placeIn, frameBoxes, setEntry, setClash]);

  /**
   * Memory (finding 8): the entry of a frame whose text went is kept for the undo that brings it back, and dropped once
   * the history no longer holds the change that took it (or, undone, its redo). Only on a parse with no errors of the
   * text the editor holds, as the save drops it from the file then too.
   */
  const pruneGone = useCallback(() => {
    const gone = goneAt.current;
    const view = viewRef.current;
    const cur = parsedRef.current;
    if (gone.size === 0 || !view || !cur || cur.text !== textRef.current) return;
    if (headsRef.current.some((h) => h.kind === null) || cur.result.problems.some((p) => p.severity === "error")) return;
    const held = marksHeld(view.state);
    if (!held) return;
    const b = boardRef.current;
    let frames: Map<string, FrameLayout> | null = null;
    for (const [k, mark] of gone) {
      if (keysRef.current.includes(k)) {
        gone.delete(k);
        continue;
      }
      if (mark !== null && held.has(mark)) continue;
      gone.delete(k);
      minted.current.delete(k);
      for (const [t, g] of goneKeys.current) if (g === k) goneKeys.current.delete(t);
      if (!b.frames.has(k)) continue;
      frames ??= new Map(b.frames);
      frames.delete(k);
    }
    if (frames) setBoard({ ...b, frames });
  }, [setBoard]);

  const parse = useCallback(
    (text: string) => {
      const call = ++calls.current;
      // The keys follow the text before it is sent (the update listener runs updateKeys first), so these name its frames.
      const keysAt = keysRef.current;
      client.flow(docId, text).then(
        (result) => {
          if (!alive.current) return;
          const cur = parsedRef.current;
          // Every call waiting on one parse resolves with it: the newest of those calls holds the parsed text.
          if (cur && (result.version < cur.result.version || (result.version === cur.result.version && call < cur.call))) return;
          // A frame drawn faded draws only its own last good doc, as the worker keeps it (B4): the canvas, the
          // board scene and Publish all read the same one.
          const drawns = result.frames.map((f) => f.doc ?? f.lastValid);
          const next = { result, text, drawns, call, keys: keysAt };
          parsedRef.current = next;
          setRaw(next);
          handle.current?.update({ errors: result.problems.filter((p) => p.severity === "error").length });
          for (const check of [...waiters.current.keys()]) check();
          placeFrames();
          pruneGone();
        },
        () => {
          // The diagram closed, or the engine restarted (which parses again): nothing to do.
        },
      );
    },
    [client, docId, name, placeFrames, pruneGone],
  );

  /** Resolves once a parse newer than `version` has arrived (at once when it already has), after a while, or on close. */
  const nextParse = useCallback((version: number) => {
    return new Promise<void>((resolve) => {
      if ((parsedRef.current?.result.version ?? -1) > version) return resolve();
      const finish = () => {
        clearTimeout(timer);
        waiters.current.delete(check);
        resolve();
      };
      const check = () => {
        if ((parsedRef.current?.result.version ?? -1) > version) finish();
      };
      const timer = setTimeout(finish, NEXT_PARSE_MS);
      waiters.current.set(check, finish);
    });
  }, []);

  const applyPositions = useCallback(
    (key: string, after: Positions) => {
      minted.current.delete(key);
      editEntry(key, (e) => {
        const nodes = emptyPositions();
        Object.assign(nodes, e.nodes);
        for (const k of Object.keys(after)) nodes[k] = after[k];
        return { ...e, nodes };
      });
      scheduleSave();
    },
    [editEntry, scheduleSave],
  );

  /** Makes sketch changes on the board, outside the history (an effect, an undo or a redo of one). */
  const applySketchChanges = useCallback(
    (changes: readonly SketchChange[]) => {
      const b = boardRef.current;
      const sketches = applySketches(b.sketches, changes);
      if (sketches === b.sketches) return;
      setBoard({ ...b, sketches });
      scheduleSave();
    },
    [setBoard, scheduleSave],
  );

  /** Sets or drops the axes of + lines (N2). */
  const applyAxes = useCallback(
    (key: string, change: AxisChange) => {
      minted.current.delete(key);
      editEntry(key, (e) => {
        const axes = Object.create(null) as Record<string, "v" | "h">;
        for (const [k, v] of Object.entries(e.axes ?? {})) if (!own(change, k)) axes[k] = v;
        for (const [k, v] of Object.entries(change)) if (v) axes[k] = v;
        return { ...e, axes };
      });
      scheduleSave();
    },
    [editEntry, scheduleSave],
  );

  /** A node's kept box as `box` says: its place, and its size or none. */
  const applyBox = useCallback(
    (key: string, name: string, box: KeptBox) => {
      minted.current.delete(key);
      editEntry(key, (e) => {
        const nodes = emptyPositions();
        Object.assign(nodes, e.nodes);
        if (box.at) nodes[name] = box.at;
        const sizes = Object.create(null) as Record<string, { w: number; h: number }>;
        for (const [k, v] of Object.entries(e.sizes ?? {})) if (k !== name) sizes[k] = v;
        if (box.size) sizes[name] = box.size;
        return { ...e, nodes, sizes };
      });
      scheduleSave();
    },
    [editEntry, scheduleSave],
  );

  /** `name`'s kept box in `key`'s entry now. */
  const keptBox = useCallback((key: string, name: string): KeptBox => {
    const e = boardRef.current.frames.get(key);
    const at = e && own(e.nodes, name) ? e.nodes[name] : undefined;
    const size = e?.sizes && own(e.sizes, name) ? e.sizes[name] : null;
    return { ...(at ? { at } : {}), size };
  }, []);

  /** A box change in the selected frame as its own undo entry (or applied at once before the text is open). */
  const changeBox = useCallback(
    (name: string, after: KeptBox) => {
      const frame = selFrame();
      if (!frame) return;
      const before = keptBox(frame.key, name);
      const view = viewRef.current;
      if (view) view.dispatch({ effects: sizeEffect.of({ frame, name, before, after }), annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
      else applyBox(frame.key, name, after);
    },
    [selFrame, keptBox, applyBox],
  );

  /** One entry's change as its own undo entry (or applied at once before the text is open). */
  const changeFrame = useCallback(
    (key: string, before: FrameLayout | null, after: FrameLayout | null) => {
      const view = viewRef.current;
      if (view) view.dispatch({ effects: frameEffect.of({ title: key, before, after }), annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
      else {
        setEntry(key, after);
        scheduleSave();
      }
    },
    [setEntry, scheduleSave],
  );

  /**
   * A hand rename: the entry follows its frame to the new key at once, outside the history. An entry held
   * at `next` is never overwritten: false, and the frame keeps its old key until that title is free.
   */
  const rekey = useCallback(
    (old: string, next: string): boolean => {
      const b = boardRef.current;
      const e = isDup(old) ? undefined : b.frames.get(old);
      if (e && b.frames.has(next)) return false;
      if (e) {
        const frames = new Map(b.frames);
        frames.delete(old);
        frames.set(next, e);
        setBoard({ ...b, frames });
        if (minted.current.delete(old)) minted.current.add(next);
      }
      if (isDup(old)) return true;
      const r = renamed.current;
      r.delete(next);
      r.delete(old);
      r.set(old, next);
      if (r.size > RENAMES_KEPT) r.delete(r.keys().next().value!);
      return true;
    },
    [setBoard],
  );

  /** The frame keyed `old` takes the entry held under `next`; its own entry, a placed stand-in, is dropped. */
  const adopt = useCallback(
    (old: string, next: string) => {
      const b = boardRef.current;
      if (b.frames.has(old) && minted.current.has(old)) {
        const frames = new Map(b.frames);
        frames.delete(old);
        setBoard({ ...b, frames });
      }
      minted.current.delete(old);
      if (isDup(old)) return;
      const r = renamed.current;
      r.delete(next);
      r.delete(old);
      r.set(old, next);
      if (r.size > RENAMES_KEPT) r.delete(r.keys().next().value!);
    },
    [setBoard],
  );

  /**
   * Each frame's key from its header, on every document change, whatever the count. A key goes to one
   * frame only: (1) a frame whose title is still its key keeps it; (2) a frame whose title is the key another frame had
   * as its title takes it (a block moved); then, with the count unchanged, a frame whose title did not change keeps its
   * key, and a frame held under an old key whose title is the one it had keeps it; (3) with the count unchanged, the
   * frames left take the free keys in order (a hand rename, a header that does not read); (4) any frame left takes its title (an entry kept under it comes back with it) or, when that is
   * taken, a key of its own. Then a frame from (3) whose title is free is re-keyed; a title held by an entry stays held
   * unless the frame's own entry is only a placed stand-in (a header typed again finds its real entry).
   */
  const updateKeys = useCallback(
    (doc: Text, text: string, history: boolean, mark: number | null) => {
      const heads = frameHeadsOf(doc, text);
      const old = headsRef.current;
      const prev = keysRef.current;
      const oldSel = frameIndexOf(
        selRef.current,
        old.map((h) => h.title),
      );
      const selKey = oldSel === null ? null : (prev[oldSel] ?? null);
      const n = heads.length;
      const next: (string | null)[] = new Array<string | null>(n).fill(null);
      const used = new Set<string>();
      const take = (i: number, k: string) => {
        next[i] = k;
        used.add(k);
      };
      // A key is held when its frame's title was not the key (the title clashed, or the header did not read).
      const heldAt = (j: number) => prev[j] !== undefined && !isDup(prev[j]) && old[j] !== undefined && old[j].title !== prev[j];
      const ownedAt = (j: number) => prev[j] !== undefined && !isDup(prev[j]) && old[j] !== undefined && old[j].title === prev[j];
      // A frame's lines under its header, for telling apart frames whose titles are the same.
      const was = headsText.current;
      const linesOf = (hs: readonly { from: number }[], t: string, j: number) => {
        const nl = t.indexOf("\n", hs[j].from);
        return nl < 0 ? "" : t.slice(nl, j + 1 < hs.length ? hs[j + 1].from : t.length).trimEnd();
      };
      /**
       * A title alone does not say which frame is which once titles move (a paste of reordered blocks with new titles,
       * an undo of several steps): old frame `j` is not frame `i` when their lines differ and another frame now has
       * exactly `j`'s lines, or another old frame had exactly `i`'s. Only read when a title or the count changed, so
       * typing in a frame's body never slices the frames.
       */
      const moved = n !== old.length || heads.some((h, i) => h.title !== old[i].title);
      const nowLines: (string | undefined)[] = [];
      const thenLines: (string | undefined)[] = [];
      const lineNow = (x: number) => (nowLines[x] ??= linesOf(heads, text, x));
      const lineThen = (x: number) => (thenLines[x] ??= linesOf(old, was, x));
      const notThat = (i: number, j: number) => {
        if (!moved) return false;
        const mine = lineNow(i);
        const theirs = lineThen(j);
        if (mine === theirs) return false;
        for (let x = 0; x < n; x++) if (x !== i && lineNow(x) === theirs) return true;
        for (let x = 0; x < old.length; x++) if (x !== j && lineThen(x) === mine) return true;
        return false;
      };
      for (let i = 0; i < n; i++) {
        const k = prev[i];
        if (k !== undefined && k === heads[i].title && !isDup(k) && !used.has(k) && !notThat(i, i)) take(i, k);
      }
      // With the count unchanged, a frame held at its own index whose title did not change keeps its key before any
      // block-moved match unless its lines say it is another frame: a duplicate's lines are the original's, so only its
      // index tells them apart (review finding 1).
      if (n === old.length) {
        for (let i = 0; i < n; i++) {
          if (next[i] === null && heldAt(i) && old[i].title === heads[i].title && !used.has(prev[i]) && !notThat(i, i)) take(i, prev[i]);
        }
      }
      // The frame whose title is a key its own frame had as its title takes it (a block moved), unless its lines say it
      // is another frame (the frame held under another key with that title, when the owner went).
      for (let i = 0; i < n; i++) {
        if (next[i] !== null) continue;
        const j = prev.findIndex((k, j) => ownedAt(j) && k === heads[i].title && !used.has(k) && !notThat(i, j));
        if (j >= 0) take(i, prev[j]);
      }
      // With the count unchanged, a frame whose title did not change keeps its key (one held while its title clashes).
      if (n === old.length) {
        for (let i = 0; i < n; i++) {
          const k = prev[i];
          if (next[i] === null && k !== undefined && !isDup(k) && !used.has(k) && old[i].title === heads[i].title) take(i, k);
        }
      }
      // A frame held under an old key keeps it while its title is the one it had.
      for (let i = 0; i < n; i++) {
        if (next[i] !== null) continue;
        const j = old.findIndex((h, j) => heldAt(j) && h.title === heads[i].title && !used.has(prev[j]) && !notThat(i, j));
        if (j >= 0) take(i, prev[j]);
      }
      const byIndex: number[] = [];
      if (n === old.length) {
        // The frames left take the free keys in order (a frame renamed where it is, or moved and renamed in one step).
        const freeKeys = prev.filter((k) => !isDup(k) && !used.has(k));
        // A free key whose frame had exactly this frame's lines goes to it first (titles moved with the blocks).
        if (moved)
          for (let i = 0; i < n && freeKeys.length > 0; i++) {
            if (next[i] !== null) continue;
            const at = freeKeys.findIndex((k) => {
              const j = prev.indexOf(k);
              return lineThen(j) === lineNow(i);
            });
            if (at < 0) continue;
            take(i, freeKeys.splice(at, 1)[0]);
            byIndex.push(i);
          }
        for (let i = 0; i < n && freeKeys.length > 0; i++) {
          if (next[i] !== null) continue;
          take(i, freeKeys.shift()!);
          byIndex.push(i);
        }
      }
      for (let i = 0; i < n; i++) {
        if (next[i] !== null) continue;
        // A frame that comes back (an undo of its deletion) takes the key it had when it went, else its title.
        const t = heads[i].title;
        // Only an undo or redo brings a frame back; a frame typed anew with the same title is a new frame.
        const free = (k: string | undefined): k is string => history && k !== undefined && k !== t && !used.has(k) && boardRef.current.frames.has(k);
        // Several steps undone at once (a rename and a delete) bring a title back whose entry a rename moved on.
        // A title another frame took here (an undo brings back a frame whose title repeats) is followed too.
        const taken = used.has(t);
        let chained: string | undefined = t;
        for (let c = 0; c < RENAMES_KEPT && chained !== undefined && (!boardRef.current.frames.has(chained) || (taken && chained === t)); c++) chained = renamed.current.get(chained);
        const had = goneKeys.current.get(t);
        // Frames with the same lines (a duplicate and its source) each keep their key in the list: the first free one.
        const byLines = history && taken ? goneByLines.current.get(fingerprint(linesOf(heads, text, i)))?.find((k) => free(k)) : undefined;
        const found = free(had) ? had : free(chained) && (taken || !boardRef.current.frames.has(t)) ? chained : free(byLines) ? byLines : undefined;
        if (found !== undefined) {
          take(i, found);
          byIndex.push(i);
        } else take(i, used.has(t) ? dupKey(i) : t);
      }
      const keys = next as string[];
      // Frames that went: the key each had, by its title, for when it comes back.
      prev.forEach((k, j) => {
        if (isDup(k) || keys.includes(k) || old[j] === undefined) return;
        goneAt.current.set(k, mark);
        const g = goneKeys.current;
        g.delete(old[j].title);
        g.set(old[j].title, k);
        if (g.size > RENAMES_KEPT) g.delete(g.keys().next().value!);
        const l = goneByLines.current;
        // A fingerprint, never the lines: a slice would keep the whole old text alive.
        const lines = fingerprint(linesOf(old, was, j));
        const ks = (l.get(lines) ?? []).filter((x) => x !== k);
        ks.push(k);
        l.delete(lines);
        l.set(lines, ks.length > RENAMES_KEPT ? ks.slice(-RENAMES_KEPT) : ks);
        if (l.size > RENAMES_KEPT) l.delete(l.keys().next().value!);
      });
      // Where each frame's key came from, so the selection follows its frame through a re-key.
      const origin = keys.slice();
      // Re-keyed: the frames that took a free key by index, and a frame held under an old key or a key of its own
      // whose title is unique again (pending until then). Again until nothing changes: a re-key can free the title another
      // frame waits for.
      const held = new Set(byIndex);
      keys.forEach((k, i) => {
        // A frame whose title clashed (its own key) too: the title is its own once the other frame lets it go.
        if (k !== heads[i].title) held.add(i);
      });
      for (let changed = true, pass = 0; changed && pass <= n; pass++) {
        changed = false;
        for (const i of [...held].sort((x, y) => x - y)) {
          const t = heads[i].title;
          const k = keys[i];
          if (heads[i].kind === null || t === k) continue;
          // A title another frame has, or holds as its key, keeps the old key until it is unique again.
          if (heads.some((h, j) => j !== i && h.title === t) || keys.some((x, j) => j !== i && x === t)) continue;
          const b = boardRef.current.frames;
          if (b.has(t)) {
            // An entry is never overwritten: the frame takes it only when its own entry is a placed stand-in.
            if (b.has(k) && !minted.current.has(k)) continue;
            adopt(k, t);
          } else rekey(k, t);
          keys[i] = t;
          changed = true;
        }
      }
      for (const k of keys) if (!isDup(k)) renamed.current.delete(k);
      if (goneAt.current.size > 0) for (const k of keys) goneAt.current.delete(k);
      // A gone frame's key is remembered only while neither its title nor its key is in use again.
      for (const [t, k] of goneKeys.current) if (keys.includes(k) || heads.some((h) => h.title === t)) goneKeys.current.delete(t);
      // Only a list that holds a key in use again is filtered: typing in a body re-keys nothing and makes no garbage.
      for (const [l, ks] of goneByLines.current) {
        if (!ks.some((k) => keys.includes(k))) continue;
        const left = ks.filter((k) => !keys.includes(k));
        if (left.length === 0) goneByLines.current.delete(l);
        else goneByLines.current.set(l, left);
      }
      // The selection follows its frame. A board that comes down to one frame has it selected; a
      // one-frame board whose frame was let go (a click outside it, Esc) stays so, as a board of several does.
      const sel = selRef.current;
      let to: number | null = null;
      // Followed by its key or its title, it is the same frame; a fallback is another one.
      let same = false;
      if (n === 1 && (sel !== null || old.length !== 1)) {
        to = 0;
        same = sel !== null && (sel.index === 0 || sel.title === heads[0].title);
      } else if (sel) {
        const by = selKey === null ? -1 : origin.indexOf(selKey);
        const byTitle = heads.findIndex((h) => h.title === sel.title);
        to = by >= 0 ? by : byTitle >= 0 ? byTitle : Math.min(oldSel ?? sel.index, n - 1);
        same = by >= 0 || byTitle >= 0;
      }
      if (to !== null && (sel?.index !== to || sel.title !== heads[to].title)) (same ? follow : select)({ title: heads[to].title, index: to });
      headsRef.current = heads;
      headsText.current = text;
      if (keys.length !== prev.length || keys.some((k, i) => k !== prev[i])) setKeys(keys);
    },
    [rekey, adopt, select, follow, setKeys],
  );

  // Read the files; the tab joins the window's list of diagrams (unsaved mark, status bar, close guard).
  // Closing the tab writes a save still to come or one that failed, then frees the worker's state for it.
  useEffect(() => {
    alive.current = true;
    client.openFlow(docId);
    discarded.current = false;
    // Writes until nothing is due: a save that comes due while a write runs is written before it says done.
    const flush = async () => {
      for (let i = 0; i < 8; i++) {
        if (discarded.current || (saveRef.current.kind === "saved" && !saveTimer.current)) return true;
        if (!(await writeNow())) return false;
      }
      return saveRef.current.kind === "saved" && !saveTimer.current;
    };
    const discard = () => {
      discarded.current = true;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
    };
    const setReadOnly = (on: boolean) =>
      viewRef.current?.dispatch({ effects: readOnlyRef.current.reconfigure(EditorState.readOnly.of(on)) });
    const hold = (opts?: { readOnly?: boolean }): FlowHold => {
      held.current++;
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        dueWhileHeld.current = true;
      }
      if (opts?.readOnly) setReadOnly(true);
      let released = false;
      const release = (() => {
        if (released) return;
        released = true;
        held.current--;
        // Also after a close or a switch to another diagram: the editor may stay for the next one.
        if (opts?.readOnly) {
          try {
            setReadOnly(false);
          } catch {
            // The view is already gone.
          }
        }
        if (held.current > 0) return;
        if (alive.current) {
          if (dueWhileHeld.current) {
            dueWhileHeld.current = false;
            scheduleSave();
          }
        } else if (deferred.current && !discarded.current) {
          // The tab closed while held: what it still had to write goes now.
          const d = deferred.current;
          deferred.current = null;
          // No tab is left to mark: a failure joins the window's list as a failed save (the close guard asks).
          const retry = () => writeFiles(name, d).then(
            () => null,
            (e: unknown) => errorText(e),
          );
          void retry().then((failed) => {
            if (failed !== null) registerOrphanFailure(name, failed, retry);
          });
        }
      }) as FlowHold;
      // A write already on its way lands before the holder goes on.
      release.settled = Promise.all([...inflight.current]).then(() => {});
      return release;
    };
    const snapshot = () => {
      const p = payload();
      return p && { text: p.text, layout: p.layout };
    };
    const unregister = registerFlow(name, {
      save: saveRef.current.kind,
      line: null,
      col: null,
      errors: 0,
      flush,
      discard,
      isDiscarded: () => discarded.current,
      isHeld: () => held.current > 0,
      snapshot,
      hold,
    });
    handle.current = unregister;
    control.current = { flush, hold };
    readDiagram(name).then(
      (files) => {
        if (!alive.current) return;
        diskText.current = files.text;
        crlf.current = isCrlf(files.text);
        const text = files.text.replace(/\r\n?/g, "\n");
        textRef.current = text;
        // The layout is read before the first parse, with the frame list read from the headers.
        const heads = frameHeaders(text);
        headsRef.current = heads;
        headsText.current = text;
        setKeys(keysFromTitles(heads));
        // A sourced frame retitled into a clash keeps holding the diagram Ask (Task 4b review minor 1).
        setBoard(adoptStraySources(parseBoardLayout(files.layout, heads), heads));
        lastSaved.current = files.layout;
        // A board with one frame opens with it selected; one with more opens with none.
        select(heads.length === 1 ? { title: heads[0].title, index: 0 } : null);
        setInitialText(files.text);
      },
      (e) => {
        if (alive.current) setReadError(errorText(e));
      },
    );
    // A restarted worker numbers its parses from 1 again and has lost this text: start over with it.
    const offRestart = client.onRestart(() => {
      if (!alive.current) return;
      const cur = parsedRef.current;
      if (cur) parsedRef.current = { ...cur, result: { ...cur.result, version: 0 }, call: 0 };
      client.openFlow(docId);
      const view = viewRef.current;
      if (view) parse(view.state.doc.toString());
    });
    return () => {
      alive.current = false;
      offRestart();
      // A save still to come or one that failed is written, unless the user chose Discard.
      if (!discarded.current && (saveTimer.current || saveRef.current.kind !== "saved")) {
        // Held (a delete or rename is on its way): the write is kept for the release instead.
        if (held.current > 0) deferred.current = payload();
        else void writeNow();
      }
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = null;
      for (const finish of [...waiters.current.values()]) finish();
      waiters.current.clear();
      unregister();
      handle.current = null;
      control.current = null;
      client.closeFlow(docId);
      parsedRef.current = null;
    };
  }, [client, docId, name, parse, setBoard, setKeys, select, writeNow, scheduleSave, payload]);

  const extensions = useMemo<Extension[]>(
    () => [
      readOnlyRef.current.of(EditorState.readOnly.of(false)),
      history(),
      sketchUndo,
      // Each text change in the history carries its mark (see `goneMark`).
      invertedEffects.of((tr) => {
        if (!tr.docChanged) return [];
        const mark = ++markSeq.current;
        marks.current.set(tr, mark);
        return [goneMark.of(mark)];
      }),
      // Undo puts a layout change back in its own frame; redo makes it again.
      invertedEffects.of((tr) => {
        const out: StateEffect<unknown>[] = [];
        for (const e of tr.effects) {
          if (e.is(moveEffect)) out.push(moveEffect.of({ frame: e.value.frame, before: e.value.after, after: e.value.before }));
          else if (e.is(sizeEffect)) out.push(sizeEffect.of({ frame: e.value.frame, name: e.value.name, before: e.value.after, after: e.value.before }));
          else if (e.is(axisEffect)) out.push(axisEffect.of({ frame: e.value.frame, before: e.value.after, after: e.value.before }));
          else if (e.is(frameEffect)) out.push(frameEffect.of({ title: e.value.title, before: e.value.after, after: e.value.before }));
        }
        return out;
      }),
      EditorView.updateListener.of((u) => {
        // The update's text, read once; an earlier transaction of several is read from its own state.
        let text: string | null = null;
        const last = u.transactions[u.transactions.length - 1];
        for (const tr of u.transactions) {
          // The keys follow the text first, so an effect in the same transaction resolves against the new frames.
          if (tr.docChanged) {
            const d = tr === last ? u.state.doc : tr.state.doc;
            updateKeys(d, tr === last ? (text ??= d.toString()) : d.toString(), tr.isUserEvent("undo") || tr.isUserEvent("redo"), marks.current.get(tr) ?? null);
          }
          const undoing = tr.isUserEvent("undo");
          const fromHistory = undoing || tr.isUserEvent("redo");
          /** An undo or redo of a change in frame `key`: the canvas goes there (a move says where its nodes go). */
          const report = (key: string, from: Positions = emptyPositions(), to: Positions = emptyPositions()) => {
            if (fromHistory) for (const fn of historyMoves.current) fn({ from, to, undo: undoing, frame: key });
          };
          for (const e of tr.effects) {
            if (e.is(sizeEffect)) {
              const key = resolveKey(e.value.frame);
              report(key);
              applyBox(key, e.value.name, e.value.after);
            } else if (e.is(axisEffect)) {
              const key = resolveKey(e.value.frame);
              report(key);
              applyAxes(key, e.value.after);
            } else if (e.is(frameEffect)) {
              const key = resolveKey({ index: -1, key: e.value.title });
              const { before, after } = e.value;
              const now = boardRef.current.frames.get(key);
              minted.current.delete(key);
              // A frame move or setting puts back only what it changed, so positions placed since stay; add and
              // delete set the whole entry (the text change shows those). An add that takes a gone frame's title has
              // both sides too: its text change is what tells it from a move, so its undo gives the kept entry back.
              const whole = tr.docChanged || !before || !after || !now;
              if (before && after && !tr.docChanged) report(key);
              setEntry(key, whole ? after : patchSettings(now, before, after));
              scheduleSave();
            } else if (e.is(sketchEffect)) applySketchChanges(e.value);
            else if (e.is(moveEffect)) {
              const key = resolveKey(e.value.frame);
              report(key, e.value.before, e.value.after);
              applyPositions(key, e.value.after);
            }
          }
        }
        if (u.docChanged) {
          text ??= u.state.doc.toString();
          textRef.current = text;
          edits.current++;
          parse(text);
          scheduleSave();
        }
        if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.some((e) => e.is(showFrame)))) {
          // Counted from the shown frame's header, as the gutter numbers it.
          const head = u.state.selection.main.head;
          const line = u.state.doc.lineAt(head);
          const first = shownRange(u.state)?.line ?? 1;
          handle.current?.update({ line: line.number - first + 1, col: head - line.from + 1 });
        }
        // An entry the history let go of with this change (its depth passed) goes too.
        if (goneAt.current.size > 0 && u.transactions.length > 0) pruneGone();
      }),
    ],
    [applyPositions, applyBox, applyAxes, applySketchChanges, setEntry, resolveKey, updateKeys, parse, scheduleSave, pruneGone, name],
  );

  const attach = useCallback(
    (view: EditorView | null) => {
      viewRef.current = view;
      if (!view) return;
      parse(view.state.doc.toString());
      handle.current?.update({ line: 1, col: 1 });
    },
    [parse, name],
  );

  /** Where each named node of `key`'s frame is now, for the `before` of a move. */
  const positionsOf = useCallback((key: string, names: string[]) => {
    const before = emptyPositions();
    const e = boardRef.current.frames.get(key);
    if (!e) return before;
    for (const k of names) if (own(e.nodes, k)) before[k] = e.nodes[k];
    return before;
  }, []);

  /** One edit list as one transaction and one undo entry of its own; `move` and `axes` belong to `frame`. */
  const dispatchEdits = useCallback(
    (view: EditorView, edits: TextEdit[], frame: FrameRef | null = null, move?: Positions, axes?: AxisChange, sizes?: Record<string, { w: number; h: number }>, sketches?: SketchChange[]) => {
      const effects: StateEffect<unknown>[] = [];
      if (sketches && sketches.length > 0) effects.push(sketchEffect.of(sketches));
      if (frame && move && Object.keys(move).length > 0) effects.push(moveEffect.of({ frame, before: positionsOf(frame.key, Object.keys(move)), after: move }));
      if (frame && sizes)
        for (const [name, size] of Object.entries(sizes)) {
          const before = keptBox(frame.key, name);
          const at = move && own(move, name) ? move[name] : before.at;
          effects.push(sizeEffect.of({ frame, name, before, after: { ...(at ? { at } : {}), size } }));
        }
      if (frame && axes && Object.keys(axes).length > 0) {
        const now = boardRef.current.frames.get(frame.key)?.axes ?? {};
        const before: AxisChange = {};
        for (const k of Object.keys(axes)) before[k] = own(now, k) ? now[k] : null;
        effects.push(axisEffect.of({ frame, before, after: axes }));
      }
      view.dispatch({
        changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })),
        effects,
        userEvent: "input.canvas",
        // A canvas edit may touch a frame the code pane does not show (ruling C4).
        annotations: [isolateHistory.of("full"), canvasEdit.of(true)],
      });
    },
    [positionsOf, keptBox],
  );

  /** The offset of the start of the first line `edits` wrote: past the line breaks and indent the insert starts with. */
  const firstLine = (view: EditorView, edits: TextEdit[]) => {
    const first = edits[0];
    const lead = first.insert.length - first.insert.replace(/^[\s]+/, "").length;
    return view.state.doc.lineAt(Math.min(first.from + lead, view.state.doc.length)).from;
  };

  const run = useCallback(
    async (op: FlowRequestOp, opts: RunOptions = {}): Promise<RunResult | null> => {
      // The frame the action is for: taken at its start whether or not the caller named one, so an answer that comes
      // back after another frame was selected writes nothing (its follow-up positions would land in the new frame).
      const started = opts.frame ?? frameIdRef.current;
      for (let i = 0; i < PLAN_TRIES; i++) {
        const view = viewRef.current;
        const cur = parsedRef.current;
        if (!view || !cur || !alive.current) return null;
        if (opts.version !== undefined && cur.result.version !== opts.version) return null;
        if (started !== frameIdRef.current) return null;
        // The frame acted on, in this parse; a board op runs on the whole text.
        const index = isBoardOp(op)
          ? 0
          : frameIndexOf(
              selRef.current,
              cur.result.frames.map((f) => f.title),
            );
        if (index === null) return null;
        // The document object the plan is made on: an answer applies only while the editor still holds it.
        const planned: Text = view.state.doc;
        let answer;
        try {
          answer = await client.flowEdit(docId, cur.result.version, op, index);
        } catch {
          return null;
        }
        // Another frame selected while the worker planned: nothing is written, quietly.
        if (started !== frameIdRef.current || !alive.current) return null;
        if (answer.stale || viewRef.current !== view || view.state.doc !== planned || cur.text !== planned.toString()) {
          // Planned on one exact version: a newer text may mean something else by it, so it is not planned again.
          if (opts.version !== undefined) return null;
          await nextParse(cur.result.version);
          continue;
        }
        // An empty list: the action does not apply to this text (a taken name, an unknown node).
        if (answer.edits.length === 0) {
          if (answer.note) opts.onRefused?.(answer.note);
          return null;
        }
        // Sketches added with the edits had their ids picked before the await: one drawn meanwhile may have taken one.
        const sketches = opts.sketches && opts.sketches.length > 0 ? freeSketchIds(boardRef.current.sketches, opts.sketches) : null;
        if (sketches && "refused" in sketches) {
          opts.onRefused?.(sketches.refused);
          return null;
        }
        // The keys are the headers of the text the plan was made on.
        const key = keysRef.current[index];
        const frame = key === undefined || isDup(key) ? null : { index, key };
        dispatchEdits(view, answer.edits, frame, opts.move, opts.axes, opts.sizes, sketches?.changes);
        return {
          at: firstLine(view, answer.edits),
          ...(answer.name === undefined ? {} : { name: answer.name }),
          ...(answer.names === undefined ? {} : { names: answer.names }),
          ...(answer.note === undefined ? {} : { note: answer.note }),
          ...(frame ? { frame } : {}),
          ...(sketches ? { sketchIds: sketches.changes.filter((c) => c.before === null && c.after !== null).map((c) => c.id) } : {}),
        };
      }
      return null;
    },
    [client, docId, dispatchEdits, nextParse],
  );

  /**
   * `frameOp`'s protocol: a board op planned on the text the editor holds, planned again on a newer parse when the
   * text moved meanwhile. `land` gets the answer in the same tick as the check that the editor still holds the planned
   * text, so nothing can change the text between that check and its dispatch. Null when it never landed.
   */
  const planBoard = useCallback(
    async <T,>(op: FlowBoardOp, land: (view: EditorView, answer: Extract<FlowEditAnswer, { stale: false }>) => T): Promise<T | null> => {
      for (let i = 0; i < PLAN_TRIES; i++) {
        const view = viewRef.current;
        const cur = parsedRef.current;
        if (!view || !cur || !alive.current) return null;
        const planned: Text = view.state.doc;
        if (cur.text !== planned.toString()) {
          await nextParse(cur.result.version);
          continue;
        }
        let answer;
        try {
          answer = await client.flowEdit(docId, cur.result.version, op);
        } catch {
          return null;
        }
        if (answer.stale || viewRef.current !== view || view.state.doc !== planned) {
          await nextParse(cur.result.version);
          continue;
        }
        return land(view, answer);
      }
      return null;
    },
    [client, docId, nextParse],
  );

  const frameOp = useCallback(
    (op: FlowBoardOp, at?: { x: number; y: number }, onRefused?: (why: string) => void): Promise<RunResult | null> =>
      planBoard(op, (view, answer): RunResult | null => {
        if (answer.edits.length === 0) {
          if (answer.note) onRefused?.(answer.note);
          return null;
        }
        const b = boardRef.current;
        const ks = keysRef.current;
        if (op.op === "duplicateFrame") {
          const adds: NewEntry[] = [];
          if (answer.name !== undefined) {
            const place = at ?? placeNewFrame(frameBoxes());
            const src = b.frames.get(ks[op.frameIndex] ?? "");
            const kind = headsRef.current[op.frameIndex]?.kind ?? null;
            adds.push({ title: answer.name, after: src ? { ...cloneEntry(src), at: { ...place } } : newEntry(kind, { ...place }) });
          }
          view.dispatch(frameAddSpec(view.state, answer.edits, adds, b));
          return { at: firstLine(view, answer.edits), ...(answer.name === undefined ? {} : { name: answer.name }) };
        }
        const effects: StateEffect<unknown>[] = [];
        if (op.op === "deleteFrame") {
          const key = ks[op.frameIndex];
          const e = key === undefined || isDup(key) ? undefined : b.frames.get(key);
          if (key !== undefined && e) effects.push(frameEffect.of({ title: key, before: e, after: null }));
        }
        // A rename needs no effect: the entry follows the title when the keys are read.
        const changes = view.state.changes(answer.edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })));
        view.dispatch({ changes, effects, userEvent: "input.canvas", annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
        return { at: firstLine(view, answer.edits), ...(answer.name === undefined ? {} : { name: answer.name }) };
      }),
    [frameBoxes, planBoard],
  );

  const addFrames = useCallback(
    async (frames: readonly NewFrame[], centre: Point): Promise<{ titles: string[]; boxes: Rect[] } | { refused: string }> => {
      if (frames.length === 0) return { titles: [], boxes: [] };
      const op: FlowBoardOp = { op: "appendFrames", frames: frames.map((f) => f.text) };
      // The caps first (B2 review): the worker's own answer on the text the editor holds, so a template the board
      // cannot take costs no layout. The add itself is planned again after the layout, on the text then.
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (view && cur && alive.current && cur.text === view.state.doc.toString()) {
        try {
          const first = await client.flowEdit(docId, cur.result.version, op);
          if (!first.stale && first.edits.length === 0) return { refused: first.note ?? "" };
        } catch {
          return { refused: "" };
        }
      }
      // Laid out and measured before the write (decision 8): nothing is laid out again once the parse lands.
      const { entries, boxes } = await measureNewFrames(frames, centre, layoutNodes);
      const landed = await planBoard(op, (v, answer) => {
        if (answer.edits.length === 0) return { refused: answer.note ?? "" };
        const titles = frames.map((_, i) => answer.names?.[String(i)] ?? "");
        if (titles.some((t) => t === "")) return { refused: "" };
        v.dispatch(
          frameAddSpec(
            v.state,
            answer.edits,
            titles.map((title, i) => ({ title, after: entries[i] })),
            boardRef.current,
          ),
        );
        return { titles, boxes };
      });
      return landed ?? { refused: "" };
    },
    [client, docId, layoutNodes, planBoard],
  );

  const prepareFrames = useCallback(
    async (frames: readonly NewFrame[], titles: readonly string[], centre: Point): Promise<LandedFrames> => {
      if (titles.length < frames.length) throw new Error(`prepareFrames: ${titles.length} titles for ${frames.length} frames`);
      const { entries, boxes } = await measureNewFrames(frames, centre, layoutNodes);
      return { entries: entries.map((after, i) => ({ title: titles[i], after })), boxes };
    },
    [layoutNodes],
  );

  const current = useCallback(async (): Promise<Parsed | null> => {
    for (let i = 0; i < PLAN_TRIES; i++) {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || !alive.current) return null;
      if (cur.text === view.state.doc.toString()) return focus(cur, selRef.current, parseKeys(cur.keys));
      await nextParse(cur.result.version);
    }
    return null;
  }, [nextParse, parseKeys]);

  /** The selected frame's index in parse `version` (the newest parse), else by the current headers. */
  const indexIn = useCallback((version?: number): number | null => {
    const cur = parsedRef.current;
    const titles = cur && (version === undefined || cur.result.version === version) ? cur.result.frames.map((f) => f.title) : headsRef.current.map((h) => h.title);
    return frameIndexOf(selRef.current, titles);
  }, []);

  const spans = useCallback(
    async (version: number, keys: string[]) => {
      const index = indexIn(version);
      if (index === null) return null;
      try {
        const r = await client.flowSpans(docId, version, keys, [], index);
        return r.stale ? null : r.spans;
      } catch {
        return null;
      }
    },
    [client, docId, indexIn],
  );

  const plan = useCallback(
    async (op: FlowRequestOp) => {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || cur.text !== view.state.doc.toString()) return null;
      const index = isBoardOp(op) ? 0 : indexIn(cur.result.version);
      if (index === null) return null;
      try {
        const answer = await client.flowEdit(docId, cur.result.version, op, index);
        return answer.stale || answer.edits.length === 0 ? null : { edits: answer.edits, text: cur.text };
      } catch {
        return null;
      }
    },
    [client, docId, indexIn],
  );

  const onHistoryMove = useCallback((fn: (move: HistoryMove) => void) => {
    historyMoves.current.add(fn);
    return () => {
      historyMoves.current.delete(fn);
    };
  }, []);

  const applyFix = useCallback(
    (edits: TextEdit[], parsedText: string) => {
      const view = viewRef.current;
      if (!view || edits.length === 0 || view.state.doc.toString() !== parsedText) return false;
      dispatchEdits(view, edits);
      return true;
    },
    [dispatchEdits],
  );

  const move = useCallback(
    (after: Positions, from?: Positions, sketches?: SketchChange[], to?: FrameRef) => {
      const names = Object.keys(after);
      const frame = names.length > 0 ? (to ?? selFrame()) : null;
      const moved = sketches && sketches.length > 0 ? sketches : null;
      if (!frame && !moved) return;
      const effects: StateEffect<unknown>[] = [];
      if (frame) effects.push(moveEffect.of({ frame, before: from ?? positionsOf(frame.key, names), after }));
      if (moved) effects.push(sketchEffect.of(moved));
      const view = viewRef.current;
      if (view) view.dispatch({ effects, annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
      else {
        if (frame) applyPositions(frame.key, after);
        if (moved) applySketchChanges(moved);
      }
    },
    [selFrame, applyPositions, applySketchChanges, positionsOf],
  );

  const sketch = useCallback(
    (changes: SketchChange[]) => {
      if (changes.length === 0) return;
      const view = viewRef.current;
      if (view) view.dispatch({ effects: sketchEffect.of(changes), annotations: [isolateHistory.of("full"), canvasEdit.of(true)] });
      else applySketchChanges(changes);
    },
    [applySketchChanges],
  );

  const place = useCallback(
    (positions: Positions, override = false, frame?: FrameRef | null) => {
      let key: string | null;
      if (frame === undefined) key = selFrame()?.key ?? null;
      else if (frame === null) key = null;
      else {
        // The frame the run wrote to, followed through renames; gone, the positions are dropped, never written elsewhere.
        const k = resolveKey(frame);
        key = keysRef.current.includes(k) && !isDup(k) ? k : null;
      }
      if (key === null) return;
      if (!override) return placeIn(key, positions);
      editEntry(key, (e) => ({ ...e, nodes: Object.assign(emptyPositions(), e.nodes, positions) }));
    },
    [selFrame, resolveKey, placeIn, editEntry],
  );

  /**
   * Names placed only for the review overlay, by frame key, until its changes are decided (memory: a rejected shape
   * kept its place).
   */
  const proposed = useRef(new Map<string, Set<string>>());
  /** Drops the sets of frames deleted or retitled since they were placed: no frame has their key any more. */
  const pruneProposed = useCallback(() => {
    const keys = keysRef.current;
    for (const k of proposed.current.keys()) if (!keys.includes(k)) proposed.current.delete(k);
  }, []);
  const placeProposedIn = useCallback(
    (key: string, positions: Positions) => {
      if (isDup(key)) return;
      pruneProposed();
      const nodes = boardRef.current.frames.get(key)?.nodes;
      let mine = proposed.current.get(key);
      for (const n of Object.keys(positions)) {
        if (nodes && own(nodes, n)) continue;
        if (!mine) proposed.current.set(key, (mine = new Set()));
        mine.add(n);
      }
      placeIn(key, positions);
    },
    [placeIn, pruneProposed],
  );
  const settleProposedIn = useCallback(
    (key: string, names: ReadonlySet<string> | ReadonlyMap<string, unknown>) => {
      const mine = proposed.current.get(key);
      proposed.current.delete(key);
      pruneProposed();
      const e = boardRef.current.frames.get(key);
      const nodes = e && mine ? withoutProposed(e.nodes, mine, names) : null;
      if (e && nodes && nodes !== e.nodes) setEntry(key, { ...e, nodes });
    },
    [setEntry, pruneProposed],
  );
  const proposedSize = useCallback(() => proposed.current.size, []);
  const placeProposed = useCallback(
    (positions: Positions) => {
      const frame = selFrame();
      if (frame) placeProposedIn(frame.key, positions);
    },
    [selFrame, placeProposedIn],
  );
  const settleProposed = useCallback(
    (names: ReadonlySet<string> | ReadonlyMap<string, unknown>) => {
      const frame = selFrame();
      if (frame) settleProposedIn(frame.key, names);
      // Every other frame with proposed places settles against what its own text defines now (its last parse), so no
      // frame keeps a rejected shape's place.
      const cur = parsedRef.current;
      for (const key of [...proposed.current.keys()]) {
        const i = cur ? cur.keys.indexOf(key) : -1;
        const doc = i >= 0 ? cur!.drawns[i] : null;
        if (doc) settleProposedIn(key, new Set([...doc.nodes.map((n) => n.name), ...groupNames(doc.groups)]));
      }
      proposed.current.clear();
    },
    [selFrame, settleProposedIn],
  );

  const setFrameSetting = useCallback(
    (key: string, patch: Partial<Pick<FrameLayout, "direction" | "style" | "notation" | "textSize">>) => {
      if (isDup(key)) return;
      const e = boardRef.current.frames.get(key) ?? null;
      const base = e ?? placedEntry(kindOfKey(key));
      const want = { ...patch };
      if (want.textSize === "m") want.textSize = undefined;
      if (want.notation === "crow") want.notation = undefined;
      if ((Object.keys(want) as (keyof typeof want)[]).every((k) => base[k] === want[k])) return;
      const next: FrameLayout = { ...base, ...want };
      if (next.textSize === undefined) delete next.textSize;
      if (next.notation === undefined) delete next.notation;
      changeFrame(key, e, next);
    },
    [placedEntry, kindOfKey, changeFrame],
  );

  const moveFrame = useCallback(
    (key: string, at: { x: number; y: number }) => {
      if (isDup(key)) return;
      const e = boardRef.current.frames.get(key) ?? null;
      const base = e ?? placedEntry(kindOfKey(key));
      if (base.at.x === at.x && base.at.y === at.y) return;
      changeFrame(key, e, { ...base, at: { x: at.x, y: at.y } });
    },
    [placedEntry, kindOfKey, changeFrame],
  );

  const setStyle = useCallback(
    (style: NodeLook) => {
      const frame = selFrame();
      if (frame) setFrameSetting(frame.key, { style });
    },
    [selFrame, setFrameSetting],
  );

  const setDirection = useCallback(
    (direction: FlowDirection) => {
      const frame = selFrame();
      if (frame) setFrameSetting(frame.key, { direction });
    },
    [selFrame, setFrameSetting],
  );

  const resize = useCallback(
    (name: string, box: { x: number; y: number; w: number; h: number }) => changeBox(name, { at: { x: box.x, y: box.y }, size: { w: box.w, h: box.h } }),
    [changeBox],
  );

  /** Fit to content (erd-ux-research 5.5): a resized node lets go of its kept size, as one undo entry. */
  const unsize = useCallback(
    (name: string) => {
      const frame = selFrame();
      const sizes = frame && boardRef.current.frames.get(frame.key)?.sizes;
      if (!frame || !sizes || !own(sizes, name)) return;
      changeBox(name, { ...keptBox(frame.key, name), size: null });
    },
    [selFrame, changeBox, keptBox],
  );

  const dropAxes = useCallback(
    (keys: readonly string[]) => {
      const view = viewRef.current;
      const frame = selFrame();
      if (!view || !frame || keys.length === 0) return;
      const now = boardRef.current.frames.get(frame.key)?.axes ?? {};
      const before: AxisChange = {};
      const after: AxisChange = {};
      for (const k of keys) {
        if (!own(now, k)) continue;
        before[k] = now[k];
        after[k] = null;
      }
      if (Object.keys(after).length === 0) return;
      view.dispatch({ effects: axisEffect.of({ frame, before, after }), annotations: [Transaction.addToHistory.of(false), canvasEdit.of(true)] });
    },
    [selFrame],
  );

  const linesOf = useCallback(
    async (names: string[]) => {
      const view = viewRef.current;
      const cur = parsedRef.current;
      if (!view || !cur || cur.text !== view.state.doc.toString()) return null;
      const index = indexIn(cur.result.version);
      if (index === null) return null;
      try {
        const r = await client.flowSpans(docId, cur.result.version, [], names, index);
        return r.stale ? null : r.lineOf;
      } catch {
        return null;
      }
    },
    [client, docId, indexIn],
  );

  /** The view when it still holds the text of parse `version` and `edits` is not empty: what a landing may write on. */
  const landable = useCallback((edits: readonly TextEdit[], version: number): EditorView | null => {
    const view = viewRef.current;
    const cur = parsedRef.current;
    if (!view || !cur || !alive.current || edits.length === 0) return null;
    return cur.result.version === version && cur.text === view.state.doc.toString() ? view : null;
  }, []);

  const land = useCallback(
    (edits: TextEdit[], version: number) => {
      const view = landable(edits, version);
      if (!view) return false;
      dispatchEdits(view, edits);
      return true;
    },
    [dispatchEdits, landable],
  );

  const landBoard = useCallback(
    (edits: TextEdit[], version: number, adds: readonly NewEntry[]) => {
      const view = landable(edits, version);
      if (!view) return false;
      view.dispatch(frameAddSpec(view.state, edits, adds, boardRef.current));
      return true;
    },
    [landable],
  );

  const reload = useCallback(async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view || !alive.current) return false;
    try {
      const files = await readDiagram(name);
      if (!alive.current || viewRef.current !== view) return false;
      diskText.current = files.text;
      crlf.current = isCrlf(files.text);
      const text = files.text.replace(/\r\n?/g, "\n");
      if (view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, annotations: canvasEdit.of(true) });
      // What the editor holds is what the file has: nothing is due to be written back.
      savedEdits.current = edits.current;
      return true;
    } catch {
      return false;
    }
  }, [name]);

  const flush = useCallback(() => control.current?.flush() ?? Promise.resolve(false), []);
  const hold = useCallback((opts?: { readOnly?: boolean }): FlowHold => {
    const h = control.current?.hold(opts);
    if (h) return h;
    const none = (() => {}) as FlowHold;
    none.settled = Promise.resolve();
    return none;
  }, []);

  const reparse = useCallback(() => {
    const view = viewRef.current;
    if (view && alive.current) parse(view.state.doc.toString());
  }, [parse]);

  // The parse's keys followed through the renames as the board is now (a rename made while the parse is out is
  // followed at once; an entry pruned since is not). Read again only when the parse, the board or the keys change
  // (a rename moves an entry or changes a key). One array while they read the same, so `parsed` depends on exactly
  // what `focus` reads and keeps its identity across a move.
  const followed = useMemo(() => (raw ? parseKeys(raw.keys) : null), [raw, board, keys, parseKeys]);
  const followedRef = useRef(followed);
  const was = followedRef.current;
  const parseKeysNow = followed === was || (followed && was && followed.length === was.length && followed.every((k, i) => k === was[i])) ? was : followed;
  useEffect(() => {
    followedRef.current = parseKeysNow;
  }, [parseKeysNow]);
  const parsed = useMemo(() => (raw && parseKeysNow ? focus(raw, selected, parseKeysNow) : null), [raw, selected, parseKeysNow]);
  // The selected frame's layout: read through the headers as they are now (the keys change with them).
  const selIndex = frameIndexOf(
    selected,
    headsRef.current.map((h) => h.title),
  );
  const selKey = selIndex === null ? null : (keys[selIndex] ?? null);
  const selKind = selIndex === null ? null : (headsRef.current[selIndex]?.kind ?? null);
  const layout = useMemo(() => frameLayoutView(board, selKey ?? "\u0000none", selKind), [board, selKey, selKind]);

  // Writes in flight, so a key replayed after a frame switch waits for the one before it.
  const inFlight = useRef(0);
  const track = useCallback(<T>(p: Promise<T>): Promise<T> => {
    inFlight.current++;
    const done = () => {
      inFlight.current--;
    };
    p.then(done, done);
    return p;
  }, []);
  const runTracked = useCallback((op: FlowRequestOp, opts?: RunOptions) => track(run(op, opts)), [run, track]);
  const currentTracked = useCallback(() => track(current()), [current, track]);
  const frameOpTracked = useCallback(
    (op: FlowBoardOp, at?: { x: number; y: number }, onRefused?: (why: string) => void) => track(frameOp(op, at, onRefused)),
    [frameOp, track],
  );
  const addFramesTracked = useCallback((frames: readonly NewFrame[], centre: Point) => track(addFrames(frames, centre)), [addFrames, track]);

  return {
    docId,
    initialText,
    readError,
    parsed,
    layout,
    board,
    keys,
    clashLayouts,
    selected,
    frameId,
    select,
    selection: () => selRef.current,
    frameIdNow: () => frameIdRef.current,
    busy: () => inFlight.current > 0,
    save,
    extensions,
    attach,
    view: () => viewRef.current,
    run: runTracked,
    current: currentTracked,
    spans,
    plan,
    onHistoryMove,
    applyFix,
    move,
    sketch,
    place,
    placeIn,
    placeProposed,
    settleProposed,
    placeProposedIn,
    settleProposedIn,
    proposedSize,
    setStyle,
    resize,
    unsize,
    setDirection,
    dropAxes,
    frameOp: frameOpTracked,
    addFrames: addFramesTracked,
    moveFrame,
    setFrameSetting,
    linesOf,
    reparse,
    flush,
    hold,
    land,
    landBoard,
    prepareFrames,
    reload,
  };
}
