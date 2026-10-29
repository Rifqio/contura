// The board's assistant: its thread under `diagram:<name>`, the Ask that runs with the text held
// read-only and sends the whole board with the chat's id, the follow-up question that waits for the
// user's reply with the text free, and the proposal that waits for review or lands at once. A landing is
// planned here on the text the Ask was made against and goes into the editor as one transaction on that parse's
// version, so one undo takes it back. Closing the tab, or opening another diagram in it, stops a running Ask.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  aiCancelPlace,
  aiClearAttachment,
  aiDiagramAsk,
  aiDiagramPreview,
  aiNameChat,
  aiRecordToolResult,
  appendAiTurn,
  clearAiThreads,
  deleteAiThread,
  errorText,
  getAiThread,
  listAiThreads,
  renameAiThread,
  saveAiThread,
  withTurn,
} from "../../api/client";
import type { AiMessage, AiThread, BoardInput, Candidate, DiagramAskRequest, DiagramProposal, FlowAssistMode, FlowOutline, ModelPicks, Preview, ProposedChange, ThreadSummary, TitleBy, ToolOutcome } from "../../api/types";
import { buildRecord, type LiveRecord } from "../../assistant/answerRecord";
import { aiErrorOf } from "../../assistant/answerState";
import { type StreamEnd, textStore } from "../../assistant/answerStream";
import { type DiffLine, diffLines } from "../../assistant/lineDiff";
import { DIAGRAM_CHATS, onThreadsCleared } from "../../assistant/threadsCleared";
import { splitFrames } from "../../lang/flow/board";
import { type DiagramKind, quote } from "../../lang/flow/model";
import type { TextEdit } from "../../lang/protocol";
import type { FlowHold } from "../flowRegistry";
import type { Point } from "../interactions/geometry";
import type { FlowDocApi, LandedFrames, Rect } from "../useFlowDoc";
import { answerRefs, outlineParts, ringParts } from "./answerRefs";
import { boardGateFields, type FollowUpReply, MAX_TABLE_LINKS } from "./boardInput";
import { boardReview } from "./boardReview";
import {
  type BoardPlan,
  type BoardRefusal,
  boardRemovalCount,
  boardWouldBreak,
  changeFrame,
  fixQuestion,
  isRefusal,
  landedSummary,
  NO_FIT,
  planBoardLanding,
  type TouchedFrame,
  touchedFrames,
  withDependents,
} from "./proposal";

/** The tool's name on the wire and in the record. */
export const DIAGRAM_TOOL = "propose_diagram_changes";

/** How long a shape just added keeps its ring: the 600 ms hold and the 1,800 ms fade of `airing`. */
export const AIRING_MS = 2400;

/**
 * How long placing an answer may take before it goes on without the step: measuring new frames (then the landing writes
 * the text alone) and saving the turn (then it shows as not saved). The composer stays busy only this long.
 */
export const MEASURE_MS = 5_000;
export const SAVE_MS = 15_000;

/** What a save that took longer than SAVE_MS says, after "Not saved: ". */
export const SAVE_TIMED_OUT = "saving took longer than 15 seconds.";

/** `p`, or a rejection with `why` once `ms` have passed. */
function within<T>(p: Promise<T>, ms: number, why: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(why)), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

/** The place a diagram's thread and Ask live in. */
export const diagramPlace = (name: string) => `diagram:${name}`;

/** The most chats a board keeps. Mirrors the Core's `store::THREAD_LIMIT`. */
export const THREAD_LIMIT = 50;

/** The AI title calls a chat gets: the first, and one retry on the next answer. Mirrors `title::TITLE_TRIES`. */
const TITLE_TRIES = 2;

/** A chat's title by the rule: its first question, cut to 40 characters. */
const ruleTitle = (q: string) => (q.length > 40 ? `${q.slice(0, 40)}…` : q);

/** `row` first in `list`, in place of the row of the same chat, at most THREAD_LIMIT rows. */
const withRow = (list: readonly ThreadSummary[], row: ThreadSummary): ThreadSummary[] => [row, ...list.filter((t) => t.id !== row.id)].slice(0, THREAD_LIMIT);

const newId = (): string =>
  typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

/** The Ask running now: the question and the Core's status line. Its text so far is in `streamed`. */
export interface Working {
  q: string;
  askedAt: number;
  status: string | null;
  /** The Core's earlier status lines, done. */
  steps: string[];
}

/** A proposal waiting for the user, with the text and parse version it was made against. */
export interface Waiting {
  threadId: string;
  /** The time of the answer that holds it, which names it to the Core. */
  messageAt: number;
  proposal: DiagramProposal;
  /** Every frame of the board as the Ask read it, in text order: its title and outline (the removal count reads them). */
  frames: { title: string; outline: FlowOutline }[];
  /**
   * The frames the changes land in, parsed once when the proposal arrived (Decision 13: every toggle re-plans only
   * these). A frame an unclear word waits in is one of them, so its pick is checked against that frame.
   */
  touched: TouchedFrame[];
  /** The new frames' layout entries and their boxes, measured once on arrival: the review shows them there and the landing writes them (A6). */
  newFrames: LandedFrames | null;
  /**
   * The layout key of each frame of the text sent (`Parsed.keys`): a touched frame's places and count go to its key
   * even after a frame is added or removed above it while the proposal waits.
   */
  keys: readonly string[];
  text: string;
  /** The frame selected when the Ask was sent: the run holds it, and "Show in the text" shows it first. */
  frameIndex: number;
  /** That frame's identity (`frameId`) when the Ask started: the run holds it, and only it, against a switch. */
  frameId: number;
  version: number;
  rejected: ReadonlySet<number>;
  /** Auto-apply was on when it arrived. */
  auto: boolean;
  /**
   * `remove` while the more-than-3-shapes question is open, `pick` while a word waits for the user to choose its shape,
   * `broken` when Auto-apply refused a set that would leave the text a problem, `stale` when the text is no longer the
   * one the changes were made against.
   */
  step: "review" | "remove" | "pick" | "broken" | "stale";
  /** The question that was asked and how: the same Ask goes again from the error cards. */
  q: string;
  opts: AskOptions;
  /** What the text would have, for `broken`: the frame and its line (counted from the frame's start). */
  broke: { frame: string; line: number; lineText: string; message: string } | null;
  /** Why the last landing did nothing. */
  problem: string | null;
  /** The thread holding it was saved; the outcome goes to the Core only then. */
  saved: boolean;
}

/** What the last landing did, under its answer. */
export interface Landed {
  messageAt: number;
  summary: string;
  /** The 1-based lines of the new text the landing wrote. */
  lines: number[];
  /** The text before the landing: an undo that brings it back took the landing back. */
  before: string;
  /** The text the landing left: a redo that brings it back puts the landing back. */
  after: string;
  /** The landing was undone: its card offers no Undo or "Show in the text" until a redo lands it again. */
  undone?: boolean;
  /** The frame it landed in; "Show in the text" shows that frame first. */
  frameIndex: number;
}

/** An Ask that left nothing to keep: its question, and why (null when it was stopped). */
export interface Failure {
  q: string;
  error: unknown;
  /** Why it was not sent, when that was not an error of the Ask. */
  note?: string;
}

/** How an Ask goes: the model, and the board's chips (Decision 7: focus, not a lock; the AI reads the whole board). */
export interface AskOptions {
  model: string | null;
  picks: ModelPicks | null;
  /** Frame chip titles, in chip order. */
  focus: string[];
  /** The kind of a new diagram asked for from the start screen. */
  create: DiagramKind | null;
  /** The token of an attachment the Core holds; used up by the Ask that sends it. */
  attachment: string | null;
  /** False once the selection chip was removed: the request leaves the selected shapes and sketches out (the frame stays). */
  withSelection?: boolean;
}

/** What the board Ask reads from the canvas, and how it shows the frames a change is in. */
export interface BoardCanvasApi {
  /** The board as the canvas holds it now: every frame, its box, the chips, the selection and the sketch notes. */
  input(): Promise<Omit<BoardInput, "followUp" | "attachment" | "create">>;
  /** Where new frames go, in board coordinates: the middle of the view, as the Shelf adds them. */
  centre(): Point;
  /**
   * Brings the frames with these layout keys into view, with `extra` (board coordinates) for frames the board does not
   * have yet: one fit of the union, a jump under reduced motion. The fit is made once the text the editor holds is
   * parsed and every shape of those frames has its place, so it holds the frames as grown for what landed (live check L2).
   */
  glideTo(keys: readonly string[], extra?: readonly Rect[]): void;
  /**
   * Rings the parts an answer names, by frame layout key (a column as `columnRing`), in the frames on screen only: the
   * same ring `airing` gives a landed shape, for as long.
   */
  ring(parts: ReadonlyMap<string, ReadonlySet<string>>): void;
}

/** A follow-up waiting for the user's reply: the user's question (`q`), the model's question back, and how it went. */
export interface Asking {
  q: string;
  question: string;
  opts: AskOptions;
  /** The reply the user gave last, when its Ask did not get an answer: offered again, never lost. */
  reply?: string;
}

/**
 * The marker on a saved reply the user left blank: its text is what the model was told, and this pill in
 * its `context` says the user did not type it (Task 16's card shows it as left to the assistant). A pill, since the
 * Core keeps a message's `context` as saved and has no field for it.
 */
export const LEFT_TO_AI = "Left to the assistant";

/** A saved user turn is a blank follow-up reply, not typed. */
export const isLeftToAi = (m: Pick<AiMessage, "role" | "context">) => m.role === "user" && m.context.includes(LEFT_TO_AI);

/** Lets the Core forget an attached file; a failure leaves it to the next pick or question, which end it. */
const forgetFile = (token: string) => void aiClearAttachment(token).catch(() => {});

/** Why an Ask was not sent when the board could not be read. */
export const BOARD_UNREAD = "Could not read the board, so nothing was sent.";

/** The request's focus: the canvas's chips, then the composer's, once each, kept to titles an unclashed frame has. */
function focusOf(board: Pick<BoardInput, "frames" | "focus">, chips: readonly string[]): string[] {
  const targets = new Set(board.frames.filter((f) => !f.clash).map((f) => f.title));
  const out: string[] = [];
  for (const t of [...board.focus, ...chips]) if (targets.has(t) && !out.includes(t)) out.push(t);
  return out;
}

/** The first change whose target word still waits for a pick. */
export const firstAmbiguous = (changes: ProposedChange[]): ProposedChange | undefined => changes.find((c) => c.status.kind === "ambiguous");

/** `change` with its word replaced by the shape `name` and its status Ok. */
function picked(change: ProposedChange, name: string): ProposedChange {
  if (change.status.kind !== "ambiguous") return change;
  const [tag, fields] = Object.entries(change.op)[0];
  return { ...change, op: { [tag]: { ...(fields as object), [change.status.field]: name } } as ProposedChange["op"], status: { kind: "ok" } };
}


// ----- line hunks

/** The lines of `s` with their line breaks, so a diff of them rebuilds the text byte for byte. */
const segmentsOf = (s: string): string[] => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** A touched frame of the board: its slice of the text sent and its text after the landing. */
export type FrameSpan = { from: number; to: number; after: string };

/** The board frames `plan` changed, as spans on the text sent, in text order. New frames are not spans: they are the tail. */
export function frameSpans(touched: readonly TouchedFrame[], plan: BoardPlan): FrameSpan[] {
  const out: FrameSpan[] = [];
  for (const t of touched) {
    const a = t.slice === null || !plan.touched.includes(t.title) ? undefined : plan.after.get(t.title);
    if (t.slice && a) out.push({ from: t.slice.from, to: t.slice.to, after: a.text });
  }
  return out.sort((x, y) => x.from - y.from);
}

/** How many lines `s` has (`segmentsOf(s).length`), counted without splitting it. */
function lineCount(s: string): number {
  let n = 0;
  for (let i = s.indexOf("\n"); i !== -1; i = s.indexOf("\n", i + 1)) n++;
  return s.length > 0 && !s.endsWith("\n") ? n + 1 : n;
}

/** A run of a line diff: one line, or (`lines` set) the unchanged lines between two touched frames, kept as one text. */
type Hunk = DiffLine & { lines?: number };

/** True when `at` starts a line of `s` (or is its end). */
const lineStart = (s: string, at: number) => at === 0 || at === s.length || s[at - 1] === "\n";

/**
 * A line diff of `before` to `after`, by `lineDiff`'s capped diff (C1): each span's frame on its own, the lines
 * between spans the same, and the rest after the last span (where new frames go) as one more piece. A span that does
 * not line up with `after` on whole lines ends the pieces: the rest is diffed as one.
 */
function boardDiff(before: string, after: string, spans: readonly FrameSpan[]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let atAfter = 0;
  for (const s of spans) {
    const gap = s.from - at;
    const next = atAfter + gap;
    const end = next + s.after.length;
    const fits =
      gap >= 0 &&
      lineStart(before, s.from) &&
      lineStart(before, s.to) &&
      lineStart(after, next) &&
      end <= after.length &&
      lineStart(after, end) &&
      after.startsWith(before.slice(at, s.from), atAfter) &&
      after.startsWith(s.after, next);
    if (!fits) break;
    const same = before.slice(at, s.from);
    if (same) out.push({ op: "same", text: same, lines: lineCount(same) });
    for (const d of diffLines(segmentsOf(before.slice(s.from, s.to)), segmentsOf(s.after))) out.push(d);
    at = s.to;
    atAfter = end;
  }
  for (const d of diffLines(segmentsOf(before.slice(at)), segmentsOf(after.slice(atAfter)))) out.push(d);
  return out;
}

/** `after` as edits on `before`, one per run of changed lines, so the ghost marks cover only the lines that change. */
export function ghostEdits(before: string, after: string, spans: readonly FrameSpan[] = []): TextEdit[] {
  const edits: TextEdit[] = [];
  let pos = 0;
  let open: TextEdit | null = null;
  for (const s of boardDiff(before, after, spans)) {
    if (s.op === "same") {
      if (open) edits.push(open);
      open = null;
      pos += s.text.length;
      continue;
    }
    open ??= { from: pos, to: pos, insert: "" };
    if (s.op === "del") {
      pos += s.text.length;
      open.to = pos;
    } else open.insert += s.text;
  }
  if (open) edits.push(open);
  return edits;
}

/** The 1-based lines of `after` that are not in `before` (what a landing wrote). */
export function addedLines(before: string, after: string, spans: readonly FrameSpan[] = []): number[] {
  const out: number[] = [];
  let line = 1;
  for (const s of boardDiff(before, after, spans)) {
    if (s.op === "del") continue;
    if (s.op === "add") out.push(line);
    line += s.lines ?? 1;
  }
  return out;
}

/** The 1-based lines of `before` a change touches: the ones it removes, and the line an insert goes before. */
export function touchedLines(before: string, after: string, spans: readonly FrameSpan[] = []): number[] {
  const out = new Set<number>();
  let line = 1;
  for (const s of boardDiff(before, after, spans)) {
    if (s.op === "add") out.add(line);
    else {
      if (s.op === "del") out.add(line);
      line += s.lines ?? 1;
    }
  }
  const last = Math.max(1, lineCount(before));
  return [...out].map((n) => Math.min(n, last));
}

/** The changes `index` needs, directly or through others, with it. */
function withNeeds(w: Waiting, index: number): Set<number> {
  const out = new Set([index]);
  const stack = [index];
  while (stack.length) {
    const at = stack.pop();
    const c = w.proposal.changes.find((x) => x.index === at);
    for (const d of c?.dependsOn ?? []) {
      if (out.has(d)) continue;
      out.add(d);
      stack.push(d);
    }
  }
  return out;
}

const okIndexes = (p: DiagramProposal) => p.changes.filter((c) => c.status.kind === "ok").map((c) => c.index);
const acceptedOf = (w: Waiting) => new Set(okIndexes(w.proposal).filter((i) => !w.rejected.has(i)));

/** The changes of a proposal that land in frame `title` (a new frame's own add_frame included). */
const indexesIn = (w: Waiting, title: string) => {
  const titles = titlesOf(w);
  return w.proposal.changes.filter((c) => changeFrame(c, titles) === title).map((c) => c.index);
};

/** The first unclear change with only the candidates its frame defines, and that frame's title. */
function pickOf(w: Waiting): { change: ProposedChange; frame: string | null } | null {
  const c = firstAmbiguous(w.proposal.changes);
  if (!c || c.status.kind !== "ambiguous") return null;
  const frame = changeFrame(c, titlesOf(w));
  const t = frame === null ? undefined : w.touched.find((x) => x.title === frame);
  if (!t) return { change: c, frame };
  const own = c.status.candidates.filter((k) => t.before.defined.has(k.name));
  return { change: { ...c, status: { ...c.status, candidates: own } }, frame };
}

/** Why a pick that was not offered does nothing. */
const NOT_OFFERED = "That shape was not offered. Pick another, or cancel.";

const NO_PENDING: ReadonlyMap<string, number> = new Map();
const NO_PLACES: ReadonlyMap<string, Point> = new Map();

/** Why changes waiting for one frame do not go on while another is selected. */
const OTHER_FRAME = "These changes are for another diagram on this board. Select it again to go on.";

/** The board's titles, one per frame in text order, as the Ask read them. */
const titlesOf = (w: Pick<Waiting, "frames">) => w.frames.map((f) => f.title);

/** The board's shape count, from the outlines the Ask read: its shapes and groups, as a parse defines them. */
const shapesOf = (frames: readonly { outline: FlowOutline }[]) => frames.reduce((n, f) => n + f.outline.nodes.length + f.outline.groups.length, 0);

/** The board as the landing checks see it: one title per frame, the frame count and the shape count. */
const boardOf = (w: Pick<Waiting, "frames">) => ({ titles: titlesOf(w), frames: w.frames.length, shapes: shapesOf(w.frames) });

/** `changes` with an unclear word counted as Ok, so the frame it waits in is parsed with the rest. */
const withTargets = (changes: ProposedChange[]): ProposedChange[] => changes.map((c) => (c.status.kind === "ambiguous" ? { ...c, status: { kind: "ok" } as const } : c));

/**
 * The landing of `accepted` on the text the proposal was made against, or why it does not apply: only
 * the touched frames, parsed once on arrival, are planned; the rest of the board is left as it is.
 */
function planOf(w: Waiting, accepted: ReadonlySet<number>): BoardPlan | BoardRefusal {
  const board = boardOf(w);
  return planBoardLanding(w.text, w.touched, w.proposal.changes, accepted, { titles: board.titles, shapes: board.shapes });
}

/** The landing of `accepted`; null when it does not apply. */
function landing(w: Waiting, accepted: ReadonlySet<number>): BoardPlan | null {
  const plan = planOf(w, accepted);
  return isRefusal(plan) ? null : plan;
}

/** What `accepted` removes across the board's frames: shapes plus ER columns. */
function removalOf(w: Waiting, accepted: ReadonlySet<number>) {
  return boardRemovalCount(w.proposal.changes, accepted, w.frames);
}

/** More than 3 shapes and columns removed asks first, in either mode. */
const asksFirst = (r: { shapes: string[]; columns: string[] }) => r.shapes.length + r.columns.length > 3;

/** The shapes that just landed, by the layout key of the frame they landed in. */
export type Airing = ReadonlyMap<string, ReadonlySet<string>>;
const NO_AIRING: Airing = new Map();

/**
 * The frames a proposal is in, for the view to glide to: the layout keys of the touched frames, and the board boxes of
 * the frames it adds (`only` names the ones that landed). A frame is never named by title: titles can clash.
 */
function glideTargets(w: Waiting, only?: ReadonlySet<string>): { keys: string[]; boxes: Rect[] } {
  const keys: string[] = [];
  for (const t of w.touched) {
    const key = t.index === null ? undefined : w.keys[t.index];
    if (key !== undefined && (!only || only.has(t.title))) keys.push(key);
  }
  const boxes = w.newFrames ? w.newFrames.boxes.filter((_, i) => !only || only.has(w.newFrames!.entries[i]?.title)) : [];
  return { keys, boxes };
}

/**
 * What an Ask left out of the board it sent, from its "Board context" Steps row ("<a> in full, <b> as names, <c> left
 * out"): how many diagrams went as names only and how many were left out. Null when the whole board went, or the row
 * is not there (an Ask on a single diagram, or an older record).
 */
export function trimmedOf(record: { steps?: readonly { step: string; value: string }[] } | null | undefined): { names: number; left: number } | null {
  const row = record?.steps?.find((s) => s.step === "boardContext");
  const m = row && /(\d+) as names, (\d+) left out/.exec(row.value);
  if (!m) return null;
  const names = Number(m[1]);
  const left = Number(m[2]);
  return names + left > 0 ? { names, left } : null;
}

/** The line under an answer that was given on a trimmed board. */
export function trimmedNote(t: { names: number; left: number }): string {
  const some = (n: number, what: string) => `${n} ${n === 1 ? "diagram was" : "diagrams were"} ${what}`;
  const text = t.names > 0 && t.left > 0 ? `${some(t.names, "sent as names only")} and ${t.left} ${t.left === 1 ? "was" : "were"} left out` : t.names > 0 ? some(t.names, "sent as names only") : some(t.left, "left out");
  return `${text}. Sends lists ${t.names + t.left === 1 ? "it" : "them"}.`;
}

/**
 * The new frames' entries and boxes (A6), measured once when the proposal arrives: each new frame's text as the whole
 * Ok set would land it (its header alone when the set does not land), under the title `appendFrames` writes for it.
 * Null when no frame is added, or when they could not be measured (the landing then writes the text alone).
 */
async function newFramesOf(doc: FlowDocApi, canvas: BoardCanvasApi, w: Waiting): Promise<LandedFrames | null> {
  const adds = w.touched.filter((t) => t.slice === null);
  if (adds.length === 0) return null;
  try {
    const ok = new Set(okIndexes(w.proposal));
    const plan = ok.size > 0 ? landing(w, ok) : null;
    const frames = adds.map((t) => ({ text: plan?.after.get(t.title)?.text ?? `diagram ${t.before.kind} ${quote(t.title)}\n` }));
    // A worker that never answers costs the frames their measured place, never the proposal (the composer waits on it).
    return await within(doc.prepareFrames(frames, adds.map((t) => t.title), canvas.centre()), MEASURE_MS, "measuring took too long");
  } catch {
    return null;
  }
}

/**
 * The text the tab holds now and the board the canvas reads of that same text, with the outline of the
 * selected frame (frame 0 with none) out of that one read; null when the text keeps changing under it or the canvas
 * cannot read it.
 */
async function currentBoard(doc: FlowDocApi, canvas: BoardCanvasApi, frame?: number) {
  for (let i = 0; i < 3; i++) {
    const cur = await doc.current();
    if (!cur) return null;
    const board = await canvas.input().catch(() => null);
    if (!board) return null;
    // The canvas read the text after this one: it is the same text only while the version is.
    const now = await doc.current();
    if (!now || now.result.version !== cur.result.version) continue;
    const frameIndex = frame ?? cur.frame?.index ?? 0;
    const outline = board.frames.find((f) => f.index === frameIndex)?.outline ?? board.frames[0]?.outline ?? NO_OUTLINE;
    return { cur, outline, frameIndex, board };
  }
  return null;
}

/** The outline of a board the canvas read no frame of. */
const NO_OUTLINE: FlowOutline = { kind: null, kinds: [], nodes: [], groups: [], links: [] };

/** The most `tableLinks` a request carries (kept with the board request's builder). */
export { MAX_TABLE_LINKS };

/**
 * The board Ask's request on `read`: the whole board with the chips, the selected frame's outline with
 * `scope` whole, the chat's id, and what the Core gates the Ask on (Task 4b: every frame's source and
 * table links).
 */
function boardRequest(
  read: NonNullable<Awaited<ReturnType<typeof currentBoard>>>,
  o: { requestId: string; file: string; question: string; opts: AskOptions; threadId: string | null; followUp: FollowUpReply | null; layout: FlowDocApi["board"] },
): DiagramAskRequest {
  const selected = o.opts.withSelection === false ? { frame: read.board.selected.frame, shapes: [], sketches: [] } : read.board.selected;
  const board: BoardInput = { ...read.board, selected, focus: focusOf(read.board, o.opts.focus), create: o.opts.create, followUp: o.followUp, attachment: o.opts.attachment };
  return {
    requestId: o.requestId,
    file: o.file,
    text: read.cur.text,
    outline: read.outline,
    question: o.question,
    scope: { kind: "whole" },
    threadId: o.threadId,
    model: o.opts.model,
    picks: o.opts.picks,
    board,
    ...boardGateFields(read.cur, o.layout, read.board.frames),
  };
}

/** What a blank reply to a follow-up says, as the Core words it in the turn. */
export const BLANK_REPLY = "Choose something sensible.";

export function useBoardAsk(name: string, doc: FlowDocApi, mode: FlowAssistMode, canvas: BoardCanvasApi) {
  const place = diagramPlace(name);
  const [thread, setThreadState] = useState<AiThread | null>(null);
  const [working, setWorking] = useState<Working | null>(null);
  const [waiting, setWaitingState] = useState<Waiting | null>(null);
  const [landed, setLandedState] = useState<Landed | null>(null);
  const landedRef = useRef<Landed | null>(null);
  const setLanded = useCallback((l: Landed | null) => {
    landedRef.current = l;
    setLandedState(l);
  }, []);
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The follow-up question waiting for the user's reply; the text is free meanwhile. */
  const [asking, setAskingState] = useState<Asking | null>(null);
  const askingRef = useRef<Asking | null>(null);
  const setAsking = useCallback((a: Asking | null) => {
    askingRef.current = a;
    setAskingState(a);
  }, []);

  /** The file the Ask in flight sent: the Core holds it while it runs, and for a follow-up's reply after. */
  const flightFile = useRef<string | null>(null);
  /**
   * The follow-up is left unanswered (Cancel, another chat, another diagram): the file the Core kept for its reply
   * goes from its memory now, not with the next Ask. With `inFlight` (the tab closes, or another diagram
   * opens in it) the file of an Ask still running goes too, so a follow-up the Core ends it with has no file waiting.
   */
  const forgetReplyFile = useCallback((inFlight = false) => {
    const tokens = new Set([askingRef.current?.opts.attachment, inFlight && run.current ? flightFile.current : null]);
    for (const token of tokens) if (token) forgetFile(token);
  }, []);
  /** The newest Ask started (a counter). */
  const latest = useRef(0);
  const canvasRef = useRef(canvas);
  canvasRef.current = canvas;
  const [airing, setAiring] = useState<Airing>(NO_AIRING);
  /** What the last landing put in view and flashed, for a redo to show again. */
  const lastLanding = useRef<{ text: string; keys: string[]; boxes: Rect[]; airing: Airing } | null>(null);
  /** Why the last turn or outcome could not be kept, shown in the panel until the next Ask. */
  const [notSaved, setNotSaved] = useState<string | null>(null);
  /** The running Ask's answer text, drawn at most once per animation frame by whoever follows it. */
  const [streamed] = useState(textStore);

  /** The board's chats as summaries, newest first (Decision 16: the webview holds one thread and these). */
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  /** Why a chat could not be opened, renamed, deleted or cleared; shown until the next Ask or chat change. */
  const [chatError, setChatError] = useState<string | null>(null);
  /**
   * The chat the user chose last (a counter): New chat, a past chat or an Ask bumps it, so a load still on its way for
   * an earlier choice (the board's newest chat, a past chat) opens nothing.
   */
  const chosen = useRef(0);
  /** The AI title calls going, by chat: one at a time per chat (A20). */
  const naming = useRef(new Set<string>());
  /**
   * Chats cleared in Settings while an Ask ran or changes waited (so they stayed on screen): nothing is ever written to
   * them again, not a turn, a whole thread or an outcome. Cleared means gone.
   */
  const cleared = useRef(new Set<string>());

  const threadRef = useRef<AiThread | null>(null);
  /** Threads whose last save failed: the next Ask saves them whole, since the Core may lack what they show. */
  const unsaved = useRef(new Set<string>());
  const setThread = useCallback((t: AiThread | null) => {
    threadRef.current = t;
    setThreadState(t);
  }, []);
  const waitingRef = useRef<Waiting | null>(null);
  const setWaiting = useCallback((w: Waiting | null) => {
    waitingRef.current = w;
    setWaitingState(w);
  }, []);
  /** The read-only hold of the Ask running or the proposal waiting; released once, when either is done. */
  const holdRef = useRef<FlowHold | null>(null);
  const release = useCallback(() => {
    const h = holdRef.current;
    holdRef.current = null;
    h?.();
  }, []);
  /** Holds the text read-only again, for the steps that draw the changes in it. */
  const holdText = useCallback(() => {
    if (!holdRef.current) holdRef.current = docRef.current.hold({ readOnly: true });
  }, []);
  /** The running Ask: stopping it ends its stream at once and tells the Core once it has the Ask. */
  /** The Ask running, and the frame it belongs to from start to end (taken when it starts, Decision 24). */
  const run = useRef<{ stopped: boolean; answered: boolean; end(patch: Partial<StreamEnd>): void; started: Promise<boolean>; place: string; frameIndex: number; frameId: number } | null>(null);
  const [runFrame, setRunFrame] = useState<number | null>(null);
  /**
   * The diagram the hook is on: bumped when the tab closes or opens another diagram, so an Ask of the old one that
   * resumes afterwards changes nothing here.
   */
  const generation = useRef(0);
  const docRef = useRef(doc);
  docRef.current = doc;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const airTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const stop = useCallback(() => {
    const r = run.current;
    // An Ask whose answer has ended is only being placed (saved, measured): there is nothing left to stop.
    if (!r || r.answered) return;
    run.current = null;
    r.stopped = true;
    r.end({ stopped: true });
    void r.started.then((ok) => (ok ? aiCancelPlace(r.place) : false)).catch(() => {});
  }, []);

  // The diagram's thread loads when the tab opens; closing the tab or opening another diagram in it stops the Ask
  // and lets the text go.
  useEffect(() => {
    const g = ++generation.current;
    const live = () => generation.current === g;
    setThread(null);
    setWorking(null);
    streamed.set("", "");
    streamed.flush();
    setWaiting(null);
    setLanded(null);
    setFailure(null);
    setAsking(null);
    setNotSaved(null);
    setThreads([]);
    setChatError(null);
    naming.current.clear();
    const pick = ++chosen.current;
    listAiThreads(place)
      .then((list) => {
        const sorted = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, THREAD_LIMIT);
        if (!live()) return null;
        // A chat saved meanwhile (an Ask that answered first) stays at the top.
        setThreads((now) => now.reduceRight(withRow, sorted));
        const newest = sorted[0];
        return newest && chosen.current === pick ? getAiThread(newest.id) : null;
      })
      .then((v) => {
        if (live() && v && threadRef.current === null && chosen.current === pick) setThread(v.thread);
      })
      .catch(() => {});
    return () => {
      generation.current++;
      forgetReplyFile(true);
      stop();
      // An Ask whose answer is being placed is not stopped by `stop`: it is this diagram's no more either, so a Send on
      // the next one is never refused for it (it sees the generation move and changes nothing).
      run.current = null;
      release();
      clearTimeout(airTimer.current);
    };
  }, [place, stop, release, setThread, setWaiting, setAsking, streamed, forgetReplyFile]);

  /** Saves the turn into the diagram's thread; returns the thread's id and the answer's time. */
  const persist = useCallback(
    async (q: string, askedAt: number, text: string, answeredAt: number, record: AiMessage["record"], requestId: string, live: () => boolean, context: string[] = []) => {
      // A chat cleared while this Ask ran is gone: the turn starts a new one rather than writing it back.
      const open = threadRef.current;
      const base = open && !cleared.current.has(open.id) ? open : null;
      const at = Math.max(answeredAt, askedAt + 1);
      const add: AiMessage[] = [
        { role: "user", text: q, context, at: askedAt },
        { role: "assistant", text, context: [], at, record },
      ];
      const next: AiThread = base
        ? { ...base, messages: [...base.messages, ...add], updatedAt: askedAt }
        : { id: newId(), place, title: ruleTitle(q), messages: add, updatedAt: askedAt };
      let failed: string | null = null;
      const fail = (e: unknown) => {
        failed = errorText(e);
        return null;
      };
      /** Who wrote the stored chat's title and its failed title calls, as the Core says once it stored the turn. */
      const titled: { stored: { titleBy: TitleBy; titleTries: number } | null } = { stored: null };
      // Only the new turn goes to the Core (memory: the whole thread used to go both ways on each Ask). A thread whose
      // last save failed goes whole once more: the Core may lack turns and outcomes it shows.
      const kept =
        base && unsaved.current.has(base.id)
          ? ((await within(saveAiThread(next, requestId), SAVE_MS, SAVE_TIMED_OUT).catch(fail))?.thread ?? next)
          : // A save that never answers is a failed save: the turn shows as not saved and goes whole with the next Ask.
            await within(appendAiTurn({ threadId: next.id, place: next.place, title: next.title, updatedAt: askedAt, messages: add }, requestId), SAVE_MS, SAVE_TIMED_OUT).then(
              (v) => {
                titled.stored = { titleBy: v.titleBy, titleTries: v.titleTries };
                // An outcome kept meanwhile in this copy stays: the turn goes after the thread as it is now.
                return { ...withTurn(threadRef.current?.id === v.threadId ? threadRef.current : base, v), titleBy: v.titleBy, titleTries: v.titleTries };
              },
              (e: unknown) => fail(e) ?? next,
            );
      if (failed === null) unsaved.current.delete(next.id);
      else unsaved.current.add(next.id);
      if (live()) {
        // An unsaved turn still shows here, with why it was not kept; the clock lists it either way.
        setThread(kept);
        setThreads((list) => withRow(list, { id: kept.id, place: kept.place, title: kept.title, titleBy: kept.titleBy ?? "rule", updatedAt: kept.updatedAt, messages: kept.messages.length, topics: 0, work: null }));
        if (failed !== null) setNotSaved(`Not saved: ${failed}`);
      }
      return { threadId: kept.id, at, saved: failed === null, stored: titled.stored };
    },
    [place, setThread],
  );

  /**
   * A20: the board chat's AI title, through D2's title call, once its turn is stored under the rule's title (one call
   * per chat at a time, one retry on a later answer). A board is not database data, so no Group and no Connection gate;
   * the Core still refuses quietly when Name chats is off. The title lands only while the board is the same.
   */
  const nameChat = useCallback(
    (threadId: string, model: string | null) => {
      if (naming.current.has(threadId)) return;
      naming.current.add(threadId);
      const g = generation.current;
      aiNameChat({ requestId: newId(), place, groupId: null, threadId, model, off: [] }).then(
        (title) => {
          if (generation.current !== g) return;
          naming.current.delete(threadId);
          if (title === null) return;
          setThreads((all) => all.map((t) => (t.id === threadId ? { ...t, title, titleBy: "ai" } : t)));
          const now = threadRef.current;
          if (now?.id === threadId) setThread({ ...now, title, titleBy: "ai" });
        },
        () => {
          if (generation.current === g) naming.current.delete(threadId);
        },
      );
    },
    [place, setThread],
  );

  /** Keeps what the user did with the proposal, in the Core and in this thread's copy. */
  const record = useCallback(
    (w: Waiting, accepted: number) => {
      const outcome: ToolOutcome = { accepted, rejected: okIndexes(w.proposal).length - accepted, auto: w.auto, at: Date.now() };
      const t = threadRef.current;
      if (t && t.id === w.threadId) {
        setThread({
          ...t,
          messages: t.messages.map((m) =>
            m.role === "assistant" && m.at === w.messageAt && m.record?.toolUse ? { ...m, record: { ...m.record, toolUse: { ...m.record.toolUse, outcome } } } : m,
          ),
        });
      }
      // A thread the Core does not have cannot take its outcome.
      // Nor can one cleared meanwhile: its outcome would make it again.
      if (!w.saved || cleared.current.has(w.threadId)) return;
      const g = generation.current;
      void aiRecordToolResult(w.threadId, w.messageAt, outcome).catch((e: unknown) => {
        if (generation.current === g) setNotSaved(`Not saved: ${errorText(e)}`);
      });
    },
    [setThread],
  );

  /**
   * The touched frames' proposed places are let go, outside the history: each frame of the board keeps
   * only the shapes `plan` leaves in it (all it had, with no plan).
   */
  const settle = useCallback((w: Waiting, plan: BoardPlan | null) => {
    const d = docRef.current;
    for (const t of w.touched) {
      const key = t.index === null ? undefined : w.keys[t.index];
      if (key !== undefined) d.settleProposedIn(key, plan?.after.get(t.title)?.parse.defined ?? t.before.defined);
    }
  }, []);

  /**
   * Lands `accepted` as one transaction on the proposal's version: `land` when no frame is added, else
   * `landBoard` with the new frames' entries measured when it arrived, so one undo takes back the edits and the frames.
   * False, with nothing changed, when it does not apply.
   */
  const land = useCallback(
    (w: Waiting, accepted: ReadonlySet<number>, planned?: BoardPlan): boolean => {
      const plan = planned ?? (accepted.size > 0 ? planOf(w, accepted) : null);
      if (!plan || isRefusal(plan)) {
        // The accepted changes passed the Core's check one by one but do not land on the text together: say why
        // when the refusing edit said.
        setWaiting({ ...w, step: "review", problem: plan?.message ?? NO_FIT });
        return false;
      }
      const adds = w.newFrames && plan.added.length > 0 ? w.newFrames.entries.filter((e) => plan.added.includes(e.title)) : [];
      const d = docRef.current;
      if (!(adds.length > 0 ? d.landBoard(plan.edits, w.version, adds) : d.land(plan.edits, w.version))) {
        // The editor no longer holds the text these changes were made against.
        release();
        setWaiting({ ...w, step: "stale", problem: null });
        return false;
      }
      setWaiting(null);
      release();
      // Shapes drawn for review that did not land lose the place they were given.
      settle(w, plan);
      // The view goes to what landed, then each frame flashes the shapes that landed in it, by its layout key.
      const review = boardReview(w.touched, plan, w.proposal.changes, accepted, { titles: titlesOf(w) });
      const inReview = new Set(review.keys());
      const { keys, boxes } = glideTargets(w, inReview);
      const aired = new Map<string, ReadonlySet<string>>();
      for (const t of w.touched) {
        const rv = review.get(t.title);
        const key = t.index === null ? t.title : w.keys[t.index];
        if (!rv || key === undefined) continue;
        const names = new Set([...rv.added, ...rv.changed]);
        if (names.size > 0) aired.set(key, names);
      }
      lastLanding.current = { text: plan.text, keys, boxes, airing: aired };
      canvasRef.current.glideTo(keys, boxes);
      clearTimeout(airTimer.current);
      setAiring(aired);
      airTimer.current = setTimeout(() => setAiring(NO_AIRING), AIRING_MS);
      setLanded({ messageAt: w.messageAt, summary: landedSummary(w.proposal.changes, accepted), lines: addedLines(w.text, plan.text, frameSpans(w.touched, plan)), before: w.text, after: plan.text, frameIndex: w.frameIndex });
      record(w, accepted.size);
      return true;
    },
    [record, release, setWaiting, setLanded, settle],
  );

  /** The frame `w` is for is the one selected (frame 0 with none). */
  const onItsFrame = useCallback((w: Waiting) => docRef.current.frameIdNow() === w.frameId, []);

  /**
   * Auto-apply's landing of `ok`: the whole set at once unless it would leave a touched frame or the
   * board with a new problem; then the broken card names the frame, and nothing lands. After the remove question too.
   */
  const autoLand = useCallback(
    (w: Waiting, ok: ReadonlySet<number>) => {
      const plan = planOf(w, ok);
      if (isRefusal(plan)) {
        // The set does not land whole: it waits for review, saying why.
        setWaiting({ ...w, step: "review", problem: plan.message });
        return;
      }
      // The frame named, and the line counted from its start, as the pane numbers them.
      const broke = boardWouldBreak(w.touched, plan, boardOf(w));
      if (broke === null) {
        // A landing that did not apply has already put the proposal up for review with why.
        land(w, ok, plan);
        return;
      }
      // The board draws the lock only while the assistant works: the text is free to type in.
      release();
      setWaiting({ ...w, step: "broken", broke });
    },
    [land, release, setWaiting],
  );

  /** Where a proposal with nothing left to pick goes: the remove question, Auto-apply's landing, or the review card. */
  const proceed = useCallback(
    (w: Waiting) => {
      // A second guard behind the switch lock: the changes go on only on the frame they are for.
      if (!onItsFrame(w)) {
        setWaiting({ ...w, problem: OTHER_FRAME });
        return;
      }
      holdText();
      const ok = new Set(okIndexes(w.proposal));
      // More than 3 shapes and columns removed, summed across frames, asks first in either mode.
      if (ok.size > 0 && asksFirst(removalOf(w, ok))) {
        setWaiting({ ...w, step: "remove" });
        return;
      }
      if (ok.size > 0 && w.auto) {
        autoLand(w, ok);
        return;
      }
      setWaiting({ ...w, step: "review" });
    },
    [autoLand, holdText, setWaiting, onItsFrame],
  );

  /** A stored turn of a chat still under the rule's title, with a try left, gets its AI title (A20). */
  const titleOnce = useCallback(
    (kept: { threadId: string; stored: { titleBy: TitleBy; titleTries: number } | null }, model: string | null) => {
      if (kept.stored?.titleBy === "rule" && kept.stored.titleTries < TITLE_TRIES) nameChat(kept.threadId, model);
    },
    [nameChat],
  );

  /**
   * Asks `q` on the board. With `followUp` it is the reply to the model's follow-up question: `q` goes again with it,
   * and only the reply is saved as the user's turn.
   */
  const ask = useCallback(
    async (q: string, opts: AskOptions, followUp: FollowUpReply | null): Promise<boolean> => {
      if (run.current || waitingRef.current || !q.trim()) return false;
      flightFile.current = opts.attachment;
      setAsking(null);
      // The chat is the one this Ask goes into: a past chat still loading opens nothing over it.
      chosen.current++;
      setChatError(null);
      /** This Ask: a later one started while it saves takes over, and this one sets no state of its own after it. */
      const mine = ++latest.current;
      const blank = followUp !== null && followUp.reply.trim() === "";
      /** The user's turn as saved: the question, or the reply to a follow-up (a blank one says what the model was told). */
      const said = followUp ? (blank ? BLANK_REPLY : followUp.reply.trim()) : q;
      /** What goes back to the composer when nothing was kept: the reply to a follow-up, never the question in its place. */
      const giveBackQ = followUp ? followUp.reply : q;
      /** A reply whose Ask got no answer: the follow-up waits again with the reply, so Retry sends it as the reply. */
      /** `fileGone`: the Core no longer holds the file, so the reply goes on without it (the error card says so). */
      const waitAgain = (fileGone = false) => {
        if (followUp && latest.current === mine) setAsking({ q, question: followUp.asked, opts: fileGone ? { ...opts, attachment: null } : opts, reply: followUp.reply });
      };
      const g = generation.current;
      const current = () => generation.current === g;
      const askedAt = Date.now();
      const requestId = newId();
      const live: LiveRecord = { sent: null, steps: [], log: [], thinking: "" };
      let text = "";
      let proposal = null as DiagramProposal | null;
      let input = "";
      /** The model's follow-up question: it shows no proposal. */
      let askedBack: string | null = null;
      let ended = false;
      let finish: (e: StreamEnd) => void = () => {};
      const ending = new Promise<StreamEnd>((resolve) => (finish = resolve));
      const r = {
        stopped: false,
        answered: false,
        place,
        // The frame shown when Ask starts (frame 0 with none selected): the whole run is that frame's.
        frameIndex: docRef.current.selection()?.index ?? 0,
        frameId: docRef.current.frameIdNow(),
        started: Promise.resolve(false),
        end(patch: Partial<StreamEnd>) {
          if (ended) return;
          ended = true;
          finish({ text, done: null, error: null, partial: false, stopped: false, at: Date.now(), live: { ...live }, ...patch });
        },
      };
      run.current = r;
      setRunFrame(r.frameId);
      setFailure(null);
      setLanded(null);
      setNotSaved(null);
      streamed.set("", "");
      streamed.flush();
      setWorking({ q: said, askedAt, status: null, steps: [] });
      const d = docRef.current;
      // What the tab holds goes to disk first, so the Core reads and hashes the same text; then the text is held.
      // A save that fails stops here: the Core would read a file that is not what the tab shows.
      const flushed = await d.flush();
      if (!flushed && !r.stopped && current() && latest.current === mine) {
        if (run.current === r) run.current = null;
        // No hold is this Ask's yet; one a stopped Ask left is let go here, as a new hold would.
        release();
        setWorking(null);
        setFailure({ q: giveBackQ, error: null, note: "Not saved, so nothing was sent. Save the diagram, then send it again." });
        waitAgain();
        return false;
      }
      // A hold is never overwritten: one still held is let go first, so every hold has its release (else saving stops).
      if (!r.stopped && current()) {
        release();
        holdRef.current = d.hold({ readOnly: true });
      }
      const read = r.stopped ? null : await currentBoard(d, canvasRef.current, r.frameIndex);
      const cur = read?.cur ?? null;
      const outline = read?.outline ?? null;
      if (r.stopped || !current() || !read || !cur || !outline) {
        if (run.current === r) run.current = null;
        // The diagram this Ask was on is gone: its hold went with it, and nothing here is its business.
        if (!current()) return false;
        // Stopped, then a newer Ask was sent: the hold, the composer and the card are that Ask's.
        if (latest.current !== mine) return false;
        release();
        setWorking(null);
        // Stopped: nothing to say. Otherwise the board could not be read (the worker or the canvas).
        setFailure(r.stopped ? { q: giveBackQ, error: null } : { q: giveBackQ, error: null, note: BOARD_UNREAD });
        waitAgain();
        return false;
      }
      const sentText = cur.text;
      const askedIndex = read?.frameIndex ?? r.frameIndex;
      const version = cur.result.version;
      // The chat goes with it: the Core reads its last turns as history.
      const request = boardRequest(read, { requestId, file: name, question: q, opts, threadId: threadRef.current?.id ?? null, followUp, layout: docRef.current.board });
      const asking = aiDiagramAsk(request, (e) => {
        if (ended) return;
        switch (e.type) {
          case "delta":
            text += e.text;
            if (current()) streamed.set(text, "");
            break;
          case "status":
            if (current()) setWorking((w) => w && { ...w, status: e.step, steps: w.status && w.status !== e.step ? [...w.steps, w.status] : w.steps });
            break;
          case "thinking":
            live.thinking += e.text;
            break;
          case "thinkingKept":
            live.thinking = e.text;
            break;
          case "log": {
            const { type: _, ...line } = e;
            live.log = [...live.log, line];
            break;
          }
          case "sent": {
            const { type: _, ...sent } = e;
            live.sent = sent;
            break;
          }
          case "process": {
            const { type: _, ...step } = e;
            live.steps = [...live.steps, step];
            break;
          }
          case "proposal":
            proposal = e.proposal;
            input = e.input;
            break;
          case "followUp":
            askedBack = e.question;
            break;
          case "done":
            r.end({ done: e });
            break;
          case "error":
            if (e.error.kind === "cancelled") r.end({ stopped: true });
            else r.end({ error: { kind: "ai", message: e.error }, partial: e.partial });
            break;
        }
      });
      r.started = asking.then(
        () => true,
        (error: unknown) => {
          r.end({ error });
          return false;
        },
      );
      const end = await ending;
      // Left while it ran (the tab closed, another diagram): whatever the Core ended with, no reply will come for its
      // file, so it goes (the Core may have kept it for a follow-up after the tab's own clear).
      if (!current() && opts.attachment) forgetFile(opts.attachment);
      /** The Ask got its answer (a follow-up question is one): its chips were used. */
      const gotAnswer = end.done !== null;
      // The run stays this Ask's, and the composer busy, until its answer is placed (saved, and a proposal measured and
      // put up): no other Ask starts in between to take the hold or drop the proposal.
      r.answered = true;
      const placed = () => {
        if (run.current === r) run.current = null;
      };
      // The answer is in the thread once it is saved; the streamed copy lets go of it now.
      if (current()) {
        streamed.set("", "");
        streamed.flush();
      }
      // A closed tab, or another diagram in it, keeps nothing and lands nothing.
      if (!current()) {
        placed();
        return gotAnswer;
      }
      const keep = end.done !== null || end.text !== "" || (end.error !== null && end.live.sent !== null);
      if (!keep) {
        placed();
        setWorking(null);
        release();
        setFailure({ q: giveBackQ, error: end.error });
        // A reply whose file the Core dropped (another board's pick or question took the slot): Retry and Continue
        // go without it rather than fail the same way again.
        // (A new question's file chip is the composer's: it drops the chip and tells the Core.)
        const fileGone = followUp !== null && aiErrorOf(end.error)?.kind === "attachmentGone";
        if (fileGone && opts.attachment) forgetFile(opts.attachment);
        waitAgain(fileGone);
        return gotAnswer;
      }
      const rec = buildRecord(end, end.live);
      rec.millis ??= end.at - askedAt;
      const context = blank ? [LEFT_TO_AI] : [];
      const back = end.done ? askedBack : null;
      if (back !== null) {
        // The answer turn is the question; nothing waits for review and the text is let go while the user replies. The
        // composer stays busy until the turn is saved, so no new Ask starts under a follow-up still being set.
        release();
        const kept = await persist(said, askedAt, back, end.at, rec, requestId, current, context);
        if (current()) titleOnce(kept, opts.model);
        placed();
        if (!current() || latest.current !== mine) return gotAnswer;
        setWorking(null);
        // The Core keeps the attached file for the reply: the reply sends the same token, and the file
        // goes once the chain ends, answered or left.
        setAsking({ q, question: back, opts });
        return gotAnswer;
      }
      const got: DiagramProposal | null = end.done ? proposal : null;
      if (got) {
        rec.toolUse = { tool: DIAGRAM_TOOL, file: name, input, proposal: got, outcome: null };
      }
      const saved = await persist(said, askedAt, end.text, end.at, rec, requestId, current, context);
      if (!current()) {
        placed();
        return gotAnswer;
      }
      titleOnce(saved, opts.model);
      // A later Ask owns the hold and the composer now: nothing here is this one's to let go.
      if (latest.current !== mine) {
        placed();
        return gotAnswer;
      }
      // A reply whose Ask failed or was stopped after it left (kept with its error) still waits for its answer.
      if (end.done === null) waitAgain();
      if (!got) {
        placed();
        setWorking(null);
        release();
        // The parts the answer names that are on screen ring once; an answer never edits.
        // A failed or stopped answer is not one: nothing rings.
        if (end.error === null) {
          const board = read.board.frames;
          const parts = ringParts(answerRefs(end.text, outlineParts(board)), (at) => cur.keys[board[at].index]);
          if (parts.size > 0) canvasRef.current.ring(parts);
        }
        return gotAnswer;
      }
      const frames = read.board.frames.map((f) => ({ title: f.title, outline: f.outline }));
      const arrived: Waiting = {
        threadId: saved.threadId,
        messageAt: saved.at,
        proposal: got,
        frames,
        // Only the frames the changes name are parsed, once, here; later toggles plan on these.
        touched: touchedFrames(sentText, splitFrames(sentText), frames.map((f) => f.title), withTargets(got.changes)),
        newFrames: null,
        keys: cur.keys,
        text: sentText,
        frameIndex: askedIndex,
        frameId: r.frameId,
        version,
        rejected: new Set(),
        auto: modeRef.current === "auto",
        step: "review",
        q,
        // The attachment went with this Ask and is used up: asking again sends the board without it.
        opts: { ...opts, attachment: null },
        broke: null,
        problem: null,
        saved: saved.saved,
      };
      // The new frames are measured once, where the review shows them and the landing writes them (A6).
      const newFrames = await newFramesOf(d, canvasRef.current, arrived);
      placed();
      if (!current() || latest.current !== mine) return gotAnswer;
      setWorking(null);
      const w: Waiting = { ...arrived, newFrames };
      // Show where the changes are before they are asked about (never unseen); a pick waits on its word, so its frame.
      const at = glideTargets(w);
      canvasRef.current.glideTo(at.keys, at.boxes);
      // The last landing's ring does not keep fading over this proposal's marks.
      clearTimeout(airTimer.current);
      setAiring(NO_AIRING);
      if (firstAmbiguous(got.changes)) {
        release();
        setWaiting({ ...w, step: "pick" });
        return gotAnswer;
      }
      proceed(w);
      return gotAnswer;
    },
    [place, name, persist, release, proceed, setWaiting, setAsking, streamed, titleOnce],
  );

  /** Continue on the follow-up: the question goes again with the reply (blank: the model chooses). */
  const answer = useCallback(
    async (reply: string) => {
      const a = askingRef.current;
      if (!a) return false;
      return ask(a.q, a.opts, { asked: a.question, reply });
    },
    [ask],
  );

  /**
   * Sends `q`. While a follow-up waits, what is sent is its reply: Retry and Ask again of a reply that failed send it as
   * the reply, never as a new question (Task 16's card disables the composer meanwhile).
   */
  const send = useCallback((q: string, opts: AskOptions) => (askingRef.current ? answer(q) : ask(q, opts, null)), [ask, answer]);

  /**
   * Cancel on the follow-up: nothing is sent, and nothing more is saved. A reply that failed goes with it: its Retry
   * would send a reply to a question nobody waits on.
   */
  const cancelAsk = useCallback(() => {
    forgetReplyFile();
    setAsking(null);
    setFailure(null);
  }, [setAsking, forgetReplyFile]);

  const reject = useCallback(
    (index: number) => {
      const w = waitingRef.current;
      if (w) setWaiting({ ...w, rejected: new Set([...w.rejected, ...withDependents(w.proposal.changes, index)]), problem: null });
    },
    [setWaiting],
  );

  const accept = useCallback(
    (index: number) => {
      const w = waitingRef.current;
      if (!w) return;
      const back = withNeeds(w, index);
      setWaiting({ ...w, rejected: new Set([...w.rejected].filter((i) => !back.has(i))), problem: null });
    },
    [setWaiting],
  );

  /** Reject frame: every change in frame `title`, with the changes in other frames that need them. */
  const rejectFrame = useCallback(
    (title: string) => {
      const w = waitingRef.current;
      if (!w) return;
      const out = new Set(w.rejected);
      for (const i of indexesIn(w, title)) for (const d of withDependents(w.proposal.changes, i)) out.add(d);
      setWaiting({ ...w, rejected: out, problem: null });
    },
    [setWaiting],
  );

  /** Accept frame: every change in frame `title` back, with the changes in other frames they need. */
  const acceptFrame = useCallback(
    (title: string) => {
      const w = waitingRef.current;
      if (!w) return;
      const back = new Set<number>();
      for (const i of indexesIn(w, title)) for (const n of withNeeds(w, i)) back.add(n);
      setWaiting({ ...w, rejected: new Set([...w.rejected].filter((i) => !back.has(i))), problem: null });
    },
    [setWaiting],
  );

  const acceptAll = useCallback(() => {
    const w = waitingRef.current;
    if (!w || w.step !== "review") return;
    const accepted = acceptedOf(w);
    if (accepted.size > 0) land(w, accepted);
  }, [land]);

  /** Reject all, or Cancel on the remove question: nothing lands, and that is recorded. */
  const rejectAll = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    setWaiting(null);
    release();
    settle(w, null);
    record(w, 0);
  }, [record, release, setWaiting, settle]);

  const reviewEach = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    if (!onItsFrame(w)) {
      setWaiting({ ...w, problem: OTHER_FRAME });
      return;
    }
    holdText();
    setWaiting({ ...w, step: "review" });
  }, [holdText, setWaiting, onItsFrame]);

  /**
   * The user chose `name` for the word the first unclear change holds: a shape of that change's frame only (Decision
   * 12). The set is checked again, then goes on.
   */
  const pick = useCallback(
    (candidate: Candidate) => {
      const w = waitingRef.current;
      if (!w || w.step !== "pick") return;
      const at = firstAmbiguous(w.proposal.changes);
      const offered = pickOf(w);
      if (!at || !offered) return;
      if (offered.change.status.kind === "ambiguous" && !offered.change.status.candidates.some((c) => c.name === candidate.name)) {
        setWaiting({ ...w, problem: offered.frame ? `${candidate.name} is not in ${offered.frame}. Pick another, or cancel.` : NOT_OFFERED });
        return;
      }
      const changes = w.proposal.changes.map((c) => (c === at ? picked(c, candidate.name) : c));
      const next: Waiting = { ...w, proposal: { ...w.proposal, changes }, problem: null };
      const ok = new Set(okIndexes(next.proposal));
      if (ok.size > 0 && !landing(next, ok)) {
        setWaiting({ ...w, problem: "That choice does not fit the text. Pick another, or cancel." });
        return;
      }
      if (firstAmbiguous(changes)) setWaiting({ ...next, step: "pick" });
      else proceed(next);
    },
    [proceed, setWaiting],
  );

  /** "Ask to fix it": the changes wait no more, and a new Ask on the current text says what could not be used. */
  const askToFix = useCallback(
    (messages: string[]) => {
      const w = waitingRef.current;
      if (!w) return;
      setWaiting(null);
      settle(w, null);
      release();
      record(w, 0);
      // A board's question asks for changes that fit the board.
      void send(fixQuestion(messages, w.frames.length > 1), w.opts);
    },
    [record, release, send, setWaiting, settle],
  );

  /** Reads the text from disk into the tab, then sends `q` again on it. */
  const askAgain = useCallback(
    async (q: string, opts: AskOptions): Promise<boolean> => {
      const w = waitingRef.current;
      if (w) {
        setWaiting(null);
        settle(w, null);
        release();
        record(w, 0);
      }
      const g = generation.current;
      const ok = await docRef.current.reload();
      if (generation.current !== g) return false;
      if (!ok) {
        setFailure({ q, error: null, note: "Could not read the file from disk, so nothing was sent." });
        return false;
      }
      return send(q, opts);
    },
    [record, release, send, setWaiting, settle],
  );

  /** "Remove and redraw": the whole set, as asked; with Auto-apply, behind the same break check as any landing. */
  const removeAll = useCallback(() => {
    const w = waitingRef.current;
    if (!w) return;
    const ok = new Set(okIndexes(w.proposal));
    if (w.auto) autoLand(w, ok);
    else land(w, ok);
  }, [land, autoLand]);

  // What the waiting changes would make of the board: the ghost marks in the editor and each touched frame's review.
  // Only the touched frames, parsed when the proposal arrived, are planned again on a toggle.
  const planned = useMemo(() => {
    // An unclear word, a refused landing and a stale text have nothing to show yet.
    if (!waiting || (waiting.step !== "review" && waiting.step !== "remove")) return null;
    const accepted = acceptedOf(waiting);
    const plan = accepted.size > 0 ? landing(waiting, accepted) : null;
    const after = plan?.text ?? waiting.text;
    const proposedAt = new Map<string, Point>();
    // A new frame shows where it will land: its entry's origin, from the one measuring (A6).
    for (const e of waiting.newFrames?.entries ?? []) proposedAt.set(e.title, e.after.at);
    const spans = plan ? frameSpans(waiting.touched, plan) : [];
    return {
      ghost: { edits: ghostEdits(waiting.text, after, spans), text: waiting.text },
      lines: touchedLines(waiting.text, after, spans),
      review: plan ? boardReview(waiting.touched, plan, waiting.proposal.changes, accepted, { titles: titlesOf(waiting) }) : null,
      proposedAt,
      count: accepted.size,
      removal: waiting.step === "remove" ? { ...removalOf(waiting, accepted), adds: waiting.proposal.changes.filter((c) => accepted.has(c.index) && "add_node" in c.op).length } : null,
    };
  }, [waiting]);

  /** Each touched frame's waiting count, by the key its frame had in the text sent. */
  const pendingByKey = useMemo(() => {
    const review = planned?.review;
    if (!review || !waiting) return NO_PENDING;
    const out = new Map<string, number>();
    for (const t of waiting.touched) {
      const key = t.index === null ? undefined : waiting.keys[t.index];
      const n = review.get(t.title)?.count ?? 0;
      if (key !== undefined && n > 0) out.set(key, n);
    }
    return out;
  }, [planned, waiting]);

  /** The pick step's change, offering only the shapes of its own frame, and that frame's title. */
  const picking = useMemo(() => (waiting?.step === "pick" ? pickOf(waiting) : null), [waiting]);

  /** The live (selected) frame's review: FlowTab draws it over that frame's own nodes; the scene draws the rest. */
  const liveTitle = doc.parsed?.frame?.title;
  const overlay = liveTitle !== undefined ? (planned?.review?.get(liveTitle) ?? null) : null;

  /**
   * What an Ask of `q` would send on the text the tab holds now, as the Core builds it (R1.6), for the Sends line and
   * Show exactly. Null when the text has no outline yet.
   */
  const preview = useCallback(
    async (q: string, opts: AskOptions): Promise<Preview | null> => {
      const d = docRef.current;
      const now = await currentBoard(d, canvasRef.current);
      if (!now) return null;
      return aiDiagramPreview(boardRequest(now, { requestId: newId(), file: name, question: q, opts, threadId: threadRef.current?.id ?? null, followUp: null, layout: d.board }));
    },
    [name],
  );

  /** Shows chat `t` (null: a new chat) in place of the open one: what was the open chat's goes with it. */
  const switchTo = useCallback(
    (t: AiThread | null) => {
      setThread(t);
      forgetReplyFile();
      setAsking(null);
      setFailure(null);
      setLanded(null);
      setNotSaved(null);
      setChatError(null);
    },
    [setThread, setAsking, setLanded, forgetReplyFile],
  );

  /** An Ask runs (until its answer is placed) or changes wait: the open chat stays (ChatGPT and Cursor lock it too). */
  const busyNow = () => run.current !== null || waitingRef.current !== null;

  /** `+` and assistant.newChat: an empty chat; the next Ask starts a new thread. Refused while busy. */
  const newChat = useCallback(() => {
    if (busyNow()) return;
    chosen.current++;
    switchTo(null);
  }, [switchTo]);

  /** Opens a past chat of the board from the clock. Refused while an Ask runs or changes wait. */
  const openThread = useCallback(
    async (id: string): Promise<void> => {
      if (busyNow() || threadRef.current?.id === id) return;
      const g = generation.current;
      const pick = ++chosen.current;
      const mine = () => generation.current === g && chosen.current === pick;
      let v: Awaited<ReturnType<typeof getAiThread>>;
      try {
        v = await getAiThread(id);
      } catch (e) {
        if (mine()) setChatError(`Could not open the chat. ${errorText(e)}`);
        return;
      }
      // An Ask sent, or another chat chosen, while it loaded keeps the pane.
      if (!mine() || busyNow()) return;
      if (!v) {
        setThreads((all) => all.filter((t) => t.id !== id));
        setChatError("That chat is no longer stored.");
        return;
      }
      switchTo(v.thread);
    },
    [switchTo],
  );

  /** Rename from the clock's row: the Core's row, or why it was refused. */
  const renameThread = useCallback(
    async (id: string, title: string): Promise<ThreadSummary | string> => {
      const g = generation.current;
      try {
        const row = await renameAiThread(id, title);
        if (generation.current !== g) return row;
        setThreads((all) => all.map((t) => (t.id === id ? row : t)));
        const now = threadRef.current;
        if (now?.id === id) setThread({ ...now, title: row.title, titleBy: row.titleBy });
        return row;
      } catch (e) {
        return errorText(e);
      }
    },
    [setThread],
  );

  /** Delete from the clock's row; deleting the open chat starts a new one. */
  const deleteThread = useCallback(
    async (id: string) => {
      const g = generation.current;
      try {
        await deleteAiThread(id);
      } catch (e) {
        if (generation.current === g) setChatError(`Could not delete the chat. ${errorText(e)}`);
        return;
      }
      if (generation.current !== g) return;
      unsaved.current.delete(id);
      setThreads((all) => all.filter((t) => t.id !== id));
      if (threadRef.current?.id === id && !busyNow()) {
        chosen.current++;
        switchTo(null);
      }
    },
    [switchTo],
  );

  // Settings' Clear all AI data, or its Clear AI history (every board's chats with a place's threads): the clock empties
  // and the open chat goes (cleared means gone). A chat still busy stays on screen until its Ask or changes end, and is
  // never written to again.
  useEffect(
    () =>
      onThreadsCleared((p) => {
        if (p !== null && p !== place && p !== DIAGRAM_CHATS) return;
        const open = threadRef.current;
        if (open) cleared.current.add(open.id);
        unsaved.current.clear();
        naming.current.clear();
        setThreads([]);
        if (!busyNow()) {
          chosen.current++;
          switchTo(null);
        }
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [place, switchTo],
  );

  /** Clear all chats of the board, from the clock. */
  const clearThreads = useCallback(async () => {
    const g = generation.current;
    try {
      await clearAiThreads(place);
    } catch (e) {
      if (generation.current === g) setChatError(`Could not clear the chats. ${errorText(e)}`);
      return;
    }
    if (generation.current !== g) return;
    unsaved.current.clear();
    setThreads([]);
    if (!busyNow()) {
      chosen.current++;
      switchTo(null);
    }
  }, [place, switchTo]);

  return {
    place,
    /** The board's chats as summaries, newest first, at most THREAD_LIMIT (the clock's list). */
    threads,
    newChat,
    openThread,
    renameThread,
    deleteThread,
    clearThreads,
    /** Why the last chat action (open, delete, clear) did nothing. */
    chatError,
    /** The parse version of the text the tab holds; a new one previews the Sends line again. */
    version: doc.parsed?.result.version ?? null,
    preview,
    thread,
    working,
    /** The running Ask's answer text so far; `useStoreText(streamed)` follows it. */
    streamed,
    waiting,
    landed,
    failure,
    /** The model's follow-up question while it waits for the user's reply. */
    asking,
    answer,
    cancelAsk,
    airing,
    /** The changes that would land now; 0 when none wait. */
    pending: planned?.count ?? 0,
    /** The text is held: an Ask is running or changes wait. */
    locked: working !== null || (waiting !== null && (waiting.step === "review" || waiting.step === "remove")),
    /**
     * The identity (`frameId`) of the frame the Assistant's run belongs to, from Ask to the end of its changes (every
     * waiting step but `stale`): no switch away from it from the canvas while it is set. Null when nothing runs or waits.
     */
    heldFrame: working !== null ? runFrame : waiting !== null && waiting.step !== "stale" ? waiting.frameId : null,
    /**
     * The user's own typing took the pane to another frame while changes wait (a header typed in the pick or broken
     * step): typing wins, the changes are stale (their version no longer matches either), and the frame is let go.
     */
    frameLeft: useCallback(() => {
      const w = waitingRef.current;
      if (!w || w.step === "stale") return;
      release();
      setWaiting({ ...w, step: "stale", problem: null });
    }, [release, setWaiting]),
    ghost: planned?.ghost ?? null,
    /** The lines of the text the waiting changes touch, for "Show in the text". */
    lines: planned?.lines ?? [],
    /** The selected frame's review, drawn over its live nodes; null when it has none. */
    overlay,
    /** Each touched or new frame's review, by title; null when nothing would land. */
    review: planned?.review ?? null,
    /** Each new frame's place on the board, by title: where the landing writes it. */
    proposedAt: planned?.proposedAt ?? NO_PLACES,
    /** Each touched frame's waiting count, by layout key, for its AI Chat tab. */
    pendingByKey,
    /** What would be removed across frames, while the remove question is open. */
    removal: planned?.removal ?? null,
    /** The pick step's change with its own frame's candidates only. */
    picking,
    send,
    stop,
    reject,
    accept,
    rejectFrame,
    acceptFrame,
    acceptAll,
    rejectAll,
    reviewEach,
    removeAll,
    pick,
    askToFix,
    askAgain,
    notSaved,
    clearFailure: () => setFailure(null),
    /**
     * An undo or redo ran in the text: back at the text before the landing, the landing is undone; back at the text it
     * left, it is landed again and the card offers Undo once more.
     */
    historyMoved: useCallback((text: string) => {
      const l = landedRef.current;
      if (!l) return;
      if (!l.undone && text === l.before) {
        // The landing is taken back: its flash goes with it.
        clearTimeout(airTimer.current);
        setAiring(NO_AIRING);
        setLanded({ ...l, undone: true });
      } else if (l.undone && text === l.after) {
        // Landed again: shown and flashed as the first time.
        const again = lastLanding.current;
        if (again && again.text === text) {
          canvasRef.current.glideTo(again.keys, again.boxes);
          clearTimeout(airTimer.current);
          setAiring(again.airing);
          airTimer.current = setTimeout(() => setAiring(NO_AIRING), AIRING_MS);
        }
        setLanded({ ...l, undone: false });
      }
    }, []),
  };
}

export type BoardAsk = ReturnType<typeof useBoardAsk>;
