// The pure parts of reviewing a diagram proposal: each change as a .flow edit and a line, the landing plan across a
// board's frames, the would-break check, which changes follow which, and the texts that tell the user what happened.
// The Core has already checked every change against the outline; nothing here talks to it or to the worker.
import { plural } from "../../format/plural";
import type { DiagramOp, FlowOutline, ProposedChange, ToolOutcome } from "../../api/types";
import { type FlowEditOp, lineBreak, nodeText } from "../../lang/flow/edits";
import { type FrameSlice, shiftEdits } from "../../lang/flow/board";
import { appendFrames } from "../../lang/flow/boardEdits";
import { applyEdits, applyFlowSteps } from "../../lang/flow/service";
import {
  type ColumnFlag,
  columnFlagsText,
  type DiagramKind,
  defaultArrow,
  type FlowNodeKind,
  flowLabel,
  flowName,
  linkEndText,
  MAX_BOARD_FRAMES,
  MAX_BOARD_SHAPES,
  quote,
} from "../../lang/flow/model";
import { type FlowParse, parseFlow } from "../../lang/flow/parse";
import { MESSAGES } from "../../lang/flow/problems";
import type { TextEdit } from "../../lang/protocol";

/** Every op tag a change can carry; each switch over them is checked to be whole. */
type OpTag = DiagramOp extends infer O ? (O extends unknown ? keyof O : never) : never;

/** The one field object of an externally tagged op, with its tag. */
function parts(op: DiagramOp): { tag: OpTag; f: Record<string, string | null | undefined> } {
  const [tag, f] = Object.entries(op)[0];
  return { tag: tag as OpTag, f: f as Record<string, string | null | undefined> };
}

/** An op tag no switch knows: a newer Core's op the webview cannot land. */
const unknownTag = (_tag: never): null => null;

/** The kind an add with no kind gets: the diagrams that write a leading word or a date need one to write a line. */
const DEFAULT_KIND: Partial<Record<DiagramKind, FlowNodeKind>> = { sequence: "participant", class: "class", mindmap: "topic", timeline: "event" };

function addedKind(kind: string | null | undefined, diagram: DiagramKind | null): FlowNodeKind | null {
  if (kind) return kind as FlowNodeKind;
  return (diagram && DEFAULT_KIND[diagram]) || null;
}

/** One end of a line: the shape (an ERD's table) it is on, and the column when it names one. */
type End = { shape: string; column?: string };

/**
 * A line end as the Core writes it: a shape's name, or in an ERD `table.column`. The parse's rule: a whole shape name
 * first, then the longest part before a dot that is a table.
 */
function splitEnd(word: string, isShape: (name: string) => boolean, isTable: (name: string) => boolean): End {
  if (isShape(word)) return { shape: word };
  for (let dot = word.lastIndexOf("."); dot > 0; dot = word.lastIndexOf(".", dot - 1)) {
    const table = word.slice(0, dot);
    if (isTable(table)) return { shape: table, column: word.slice(dot + 1) };
  }
  return { shape: word };
}

function parseEnd(parse: FlowParse, word: string): End {
  if (parse.kind !== "er") return { shape: word };
  return splitEnd(
    word,
    (n) => parse.defined.has(n),
    (n) => {
      const k = parse.kindOf(n);
      return k === "entity" || k === "weak";
    },
  );
}

function outlineEnd(outline: FlowOutline, word: string): End {
  if (outline.kind !== "er") return { shape: word };
  return splitEnd(
    word,
    (n) => outline.nodes.some((x) => x.name === n) || outline.groups.some((g) => g.name === n),
    (n) => outline.nodes.some((x) => x.name === n && x.columns !== undefined),
  );
}

/** True when `link` is between the ends; an end that names a column matches only a line on that column. */
function linkMatches(link: { from: string; to: string; fromColumn?: string; toColumn?: string }, from: End, to: End): boolean {
  if (link.from !== from.shape || link.to !== to.shape) return false;
  return (from.column === undefined || link.fromColumn === from.column) && (to.column === undefined || link.toColumn === to.column);
}

/** The index in `parse.links` of the first link between the ends; `label` given narrows it to that label. */
function findLink(parse: FlowParse, from: End, to: End, label: string | null | undefined, not?: string): number {
  let fallback = -1;
  for (let i = 0; i < parse.links.length; i++) {
    const l = parse.links[i];
    if (!linkMatches(l, from, to)) continue;
    if (label !== undefined && label !== null && l.label !== label) continue;
    if (not === undefined || l.label !== not) return i;
    if (fallback < 0) fallback = i;
  }
  return fallback;
}

/** The row index of `column` in an ER table, read off `text` (the parsed text); -1 when the table has none. */
function columnIndex(parse: FlowParse, text: string, table: string, column: string): number {
  return parse.rowsOf(table).findIndex((r) => r.column !== undefined && text.slice(r.column.from, r.column.to) === column);
}

/**
 * The edit a change asks for, made against `parse` (the parse of `text`, the text it will run on). A line is found by
 * its ends and label in that parse; in an ERD an end may be `table.column`. Null when the change is not Ok, its line
 * or column is not there, or it is a new frame (`appendFrames` lands those). The column ops need `text`.
 */
export function changeEditOp(change: ProposedChange, parse: FlowParse, kind: DiagramKind | null, text?: string): FlowEditOp | null {
  if (change.status.kind !== "ok") return null;
  const { tag, f } = parts(change.op);
  switch (tag) {
    case "add_node":
      return { op: "addNode", name: f.name as string, kind: addedKind(f.kind, kind), attrs: f.id ? { id: f.id } : {}, group: f.group ?? null };
    case "remove_node":
      return { op: "deleteNode", name: f.target as string };
    case "rename_node":
      return { op: "renameNode", old: f.target as string, next: f.name as string };
    case "add_flow": {
      const from = parseEnd(parse, f.from as string);
      const to = parseEnd(parse, f.to as string);
      return {
        op: "addLink",
        from: from.shape,
        to: to.shape,
        arrow: defaultArrow(kind),
        label: f.label ?? undefined,
        ...(from.column !== undefined ? { fromColumn: from.column } : {}),
        ...(to.column !== undefined ? { toColumn: to.column } : {}),
      };
    }
    case "remove_flow": {
      const index = findLink(parse, parseEnd(parse, f.from as string), parseEnd(parse, f.to as string), f.label);
      return index < 0 ? null : { op: "deleteLink", index };
    }
    case "relabel_flow": {
      // The label given is the new one: prefer a line that does not already carry it.
      const index = findLink(parse, parseEnd(parse, f.from as string), parseEnd(parse, f.to as string), undefined, f.label as string);
      return index < 0 ? null : { op: "setLinkLabel", index, label: f.label as string };
    }
    case "move_to_group":
      return { op: "moveToGroup", name: f.target as string, group: f.group ?? null };
    case "add_frame":
      return null;
    case "add_column": {
      const table = f.table as string;
      const flags = (f.flags as unknown as ColumnFlag[] | null | undefined) ?? [];
      // Decision 3: at the table's end; an empty type writes an untyped column.
      return { op: "addColumn", table, at: parse.rowsOf(table).length, before: null, name: f.name as string, type: f.type ?? "", flags };
    }
    case "set_column":
    case "remove_column": {
      const table = f.table as string;
      const column = f.column as string;
      const index = text === undefined ? -1 : columnIndex(parse, text, table, column);
      if (index < 0) return null;
      if (tag === "remove_column") return { op: "deleteColumn", table, index, column };
      return { op: "setColumn", table, index, column, ...(f.name != null ? { name: f.name } : {}), ...(f.type != null ? { type: f.type } : {}) };
    }
    default:
      return unknownTag(tag);
  }
}

/** The .flow line a change writes or removes, as the review lists it. A rename, move or removal of a shape lists its name. */
export function changeLine(change: ProposedChange, kind: DiagramKind | null): string {
  const { tag, f } = parts(change.op);
  const link = (from: string, to: string, label: string | null | undefined) => `${flowName(from)} ${defaultArrow(kind)} ${flowName(to)}${label ? `: ${flowLabel(label)}` : ""}`;
  switch (tag) {
    case "add_node":
      return nodeText(f.name as string, addedKind(f.kind, kind), f.id ? { id: f.id } : {}, kind);
    case "remove_node":
    case "move_to_group":
      return flowName(f.target as string);
    case "rename_node":
      return flowName(f.name as string);
    case "add_flow":
    case "remove_flow":
    case "relabel_flow":
      return link(f.from as string, f.to as string, f.label);
    case "add_frame":
      return `diagram ${f.kind} ${quote(f.title as string)}`;
    case "add_column": {
      const flags = (f.flags as unknown as ColumnFlag[] | null | undefined) ?? [];
      return `${linkEndText(f.table as string, f.name as string)}${f.type ? ` ${f.type}` : ""}${columnFlagsText(flags)}`;
    }
    case "set_column":
      return `${linkEndText(f.table as string, (f.name ?? f.column) as string)}${f.type ? ` ${f.type}` : ""}`;
    case "remove_column":
      return linkEndText(f.table as string, f.column as string);
    default:
      return unknownTag(tag) ?? "";
  }
}

/** `+` add, `-` remove, `~` rename, relabel, move or change, `!` a change that is not Ok (dropped, or still to pick). */
export function changeMark(change: ProposedChange): "+" | "-" | "~" | "!" {
  if (change.status.kind !== "ok") return "!";
  const { tag } = parts(change.op);
  if (tag.startsWith("add_")) return "+";
  if (tag.startsWith("remove_")) return "-";
  return "~";
}

/**
 * The title of the frame a change lands in: a new frame's own title, the frame the Core checked it in, else the
 * board's only frame (a one-diagram Ask's changes name none). Null when it names none on a board of several.
 */
export function changeFrame(change: ProposedChange, titles: readonly string[]): string | null {
  const { tag, f } = parts(change.op);
  if (tag === "add_frame") return f.title as string;
  const named = change.frame ?? f.frame ?? null;
  if (named !== null) return named;
  return titles.length === 1 ? titles[0] : null;
}

/** A new frame's header line, in the board's line break. */
const frameHead = (kind: string | null, title: string, lb: string) => `diagram ${kind} ${quote(title)}${lb}`;

/** A frame a proposal changes: one of the board (`index` and `slice` set) or a new one (both null). */
export interface TouchedFrame {
  title: string;
  index: number | null;
  /** The frame's parse before the landing; a new frame's is the parse of its header alone. */
  before: FlowParse;
  slice: FrameSlice | null;
}

/**
 * The frames the Ok changes touch, the board's in text order and then the new ones in proposal order. Only those
 * slices are parsed, once per proposal: the review holds them while it waits. `titles[i]` is `slices[i]`'s title; a
 * title the board has twice is its first frame's.
 */
export function touchedFrames(text: string, slices: readonly FrameSlice[], titles: readonly string[], changes: ProposedChange[]): TouchedFrame[] {
  const wanted = new Set<string>();
  const added: TouchedFrame[] = [];
  const lb = lineBreak(text);
  for (const c of changes) {
    if (c.status.kind !== "ok") continue;
    const { tag, f } = parts(c.op);
    if (tag === "add_frame") {
      const title = f.title as string;
      added.push({ title, index: null, before: parseFlow(frameHead(f.kind as string, title, lb)), slice: null });
      continue;
    }
    const title = changeFrame(c, titles);
    if (title !== null) wanted.add(title);
  }
  const out: TouchedFrame[] = [];
  const seen = new Set<string>();
  slices.forEach((slice, i) => {
    const title = titles[i];
    if (title === undefined || !wanted.has(title) || seen.has(title)) return;
    seen.add(title);
    out.push({ title, index: slice.index, before: parseFlow(text.slice(slice.from, slice.to)), slice });
  });
  return [...out, ...added];
}

/** A landing across frames: the edits on the board's text, the text they give, and each changed frame after it. */
export interface BoardPlan {
  edits: TextEdit[];
  text: string;
  /** Each changed or new frame's text and parse after the landing, by title. */
  after: Map<string, { parse: FlowParse; text: string }>;
  /** The board's frames that changed, in text order. */
  touched: string[];
  /** The new frames, in the order they are appended. */
  added: string[];
}

/** Why a landing was refused, when nothing says more. */
export const NO_FIT = "These changes do not fit together. Review them again, or ask to fix it.";

/**
 * Why a landing is refused, whole: the change that refused it (`index`) and its frame when known, and what to tell
 * the user (the edit's own note, a board cap's message, or NO_FIT when nothing says more).
 */
export interface BoardRefusal {
  refused: true;
  index: number | null;
  frame: string | null;
  message: string;
}

const refuse = (index: number | null, frame: string | null, message?: string): BoardRefusal => ({ refused: true, index, frame, message: message ?? NO_FIT });

/** True when a landing plan is a refusal. */
export const isRefusal = (plan: BoardPlan | BoardRefusal): plan is BoardRefusal => "refused" in plan;

/** `changes` landed in turn on one frame's text; else the position in `changes` of the one that refused, with its note. */
function landOn(text: string, parse: FlowParse, changes: readonly ProposedChange[]): { edits: TextEdit[]; text: string; parse: FlowParse } | { at: number; note?: string } {
  let at = 0;
  const r = applyFlowSteps(text, parse, changes.length, (p, i, t) => {
    at = i;
    return changeEditOp(changes[i], p, parse.kind, t);
  });
  if (r.edits.length === 0 || r.text === undefined) return { at, ...(r.note !== undefined ? { note: r.note } : {}) };
  return { edits: r.edits, text: r.text, parse: parseFlow(r.text) };
}

/** One replace from `text` to `next`: the span between their common start and end. */
function oneEdit(text: string, next: string): TextEdit {
  let a = 0;
  while (a < next.length && a < text.length && next[a] === text[a]) a++;
  let b = 0;
  while (b < next.length - a && b < text.length - a && next[next.length - 1 - b] === text[text.length - 1 - b]) b++;
  return { from: a, to: text.length - b, insert: next.slice(a, next.length - b) };
}

/**
 * The accepted changes as one edit list on `text` and the text it gives. Each touched frame of the board, in text
 * order, takes its accepted changes in index order through `applyFlowSteps` on its own slice (so the same name in two
 * frames is never confused), shifted by the slice's start; the rest of the board is left as it is. New frames are
 * appended last through `appendFrames`. `board.titles` holds one title per frame of the board.
 *
 * Refused whole, with why (BoardRefusal), when nothing is accepted, an accepted change is not Ok, names no touched
 * frame or does not apply (its edit's note), a change's new frame is not accepted, two new frames share a title, or
 * the new frames would break the board (Decision 13a: a title the board has, more than MAX_BOARD_FRAMES frames, more
 * than MAX_BOARD_SHAPES shapes).
 */
export function planBoardLanding(
  text: string,
  touched: readonly TouchedFrame[],
  changes: ProposedChange[],
  accepted: ReadonlySet<number>,
  board: { titles: readonly string[]; shapes: number },
): BoardPlan | BoardRefusal {
  const list = changes.filter((c) => accepted.has(c.index)).sort((a, b) => a.index - b.index);
  if (list.length === 0) return refuse(null, null);
  const frames = new Map<string, TouchedFrame>();
  for (const t of touched) if (!frames.has(t.title)) frames.set(t.title, t);
  const byFrame = new Map<string, ProposedChange[]>();
  /** Each accepted new frame's add_frame index, by title. */
  const made = new Map<string, number>();
  for (const c of list) {
    const { tag, f } = parts(c.op);
    if (c.status.kind !== "ok") return refuse(c.index, tag === "add_frame" ? (f.title as string) : (c.frame ?? f.frame ?? null));
    if (tag === "add_frame") {
      const title = f.title as string;
      const t = frames.get(title);
      if (!t || t.slice !== null) return refuse(c.index, title);
      if (made.has(title)) return refuse(c.index, title, MESSAGES.frameTwice(title));
      made.set(title, c.index);
      continue;
    }
    const title = changeFrame(c, board.titles);
    const t = title === null ? undefined : frames.get(title);
    if (!t) return refuse(c.index, title);
    const mine = byFrame.get(t.title);
    if (mine) mine.push(c);
    else byFrame.set(t.title, [c]);
  }
  let edits: TextEdit[] = [];
  const after = new Map<string, { parse: FlowParse; text: string }>();
  const done: string[] = [];
  let out = "";
  let at = 0;
  let shapes = board.shapes;
  const own = touched.filter((t): t is TouchedFrame & { slice: FrameSlice } => t.slice !== null).sort((a, b) => a.slice.from - b.slice.from);
  for (const t of own) {
    const mine = byFrame.get(t.title);
    if (!mine || frames.get(t.title) !== t) continue;
    const r = landOn(text.slice(t.slice.from, t.slice.to), t.before, mine);
    if ("at" in r) return refuse(mine[r.at].index, t.title, r.note);
    edits.push(...shiftEdits(r.edits, t.slice.from));
    out += text.slice(at, t.slice.from) + r.text;
    at = t.slice.to;
    after.set(t.title, { parse: r.parse, text: r.text });
    shapes += r.parse.defined.size - t.before.defined.size;
    done.push(t.title);
  }
  out += text.slice(at);
  const lb = lineBreak(text);
  const blocks: string[] = [];
  const added: string[] = [];
  const taken = new Set(board.titles);
  /** The board's shapes once its own frames have landed, before the new ones. */
  const boardShapes = shapes;
  for (const t of touched) {
    if (t.slice !== null || frames.get(t.title) !== t) continue;
    const mine = byFrame.get(t.title);
    const index = made.get(t.title);
    if (index === undefined) {
      if (mine) return refuse(mine[0].index, t.title);
      continue;
    }
    // Decision 13a, before appendFrames would free the title or refuse without naming the frame.
    if (taken.has(t.title)) return refuse(index, t.title, MESSAGES.frameTwice(t.title));
    if (board.titles.length + added.length + 1 > MAX_BOARD_FRAMES) return refuse(index, t.title, MESSAGES.tooManyFrames);
    const head = frameHead(t.before.kind, t.title, lb);
    const r = mine ? landOn(head, t.before, mine) : { edits: [], text: head, parse: t.before };
    if ("at" in r) return refuse(mine![r.at].index, t.title, r.note);
    shapes += r.parse.defined.size;
    if (shapes > MAX_BOARD_SHAPES) return refuse(index, t.title, MESSAGES.tooManyShapes);
    blocks.push(r.text);
    added.push(t.title);
    // appendFrames ends each frame with exactly one line break.
    const written = `${r.text.replace(/\s+$/, "")}${lb}`;
    after.set(t.title, { parse: written === r.text ? r.parse : parseFlow(written), text: written });
  }
  if (blocks.length > 0) {
    const r = appendFrames(out, { frames: board.titles.map((title) => ({ parse: { title } })), shapes: boardShapes }, blocks);
    const names = r.names;
    if (r.edits.length === 0 || !names) return refuse(null, null, r.note);
    const renamed = added.findIndex((title, i) => names[String(i)] !== title);
    if (renamed >= 0) return refuse(made.get(added[renamed]) ?? null, added[renamed], MESSAGES.frameTwice(added[renamed]));
    const next = applyEdits(out, r.edits);
    // The append goes after every frame edit unless the last one reached into the trailing blank lines it replaces.
    const e = r.edits[0];
    const delta = out.length - text.length;
    const last = edits[edits.length - 1];
    if (!last || e.from >= last.to + delta) edits.push({ from: e.from - delta, to: text.length, insert: e.insert });
    else edits = [oneEdit(text, next)];
    out = next;
  }
  if (edits.length === 0) return refuse(null, null);
  return { edits, text: out, after, touched: done, added };
}

/** A message without its numbers, so a line number that moved with an insert is still the same problem. */
const sameProblem = (message: string) => message.replace(/\d+/g, "#");

/** The first error the `before` text did not have, with its line in `afterText`; null when there is none. */
export function wouldBreak(before: Pick<FlowParse, "problems">, after: Pick<FlowParse, "problems">, afterText: string): { line: number; lineText: string; message: string } | null {
  const had = new Map<string, number>();
  for (const p of before.problems) if (p.severity === "error") had.set(sameProblem(p.message), (had.get(sameProblem(p.message)) ?? 0) + 1);
  for (const p of after.problems) {
    if (p.severity !== "error") continue;
    const key = sameProblem(p.message);
    const n = had.get(key) ?? 0;
    if (n > 0) {
      had.set(key, n - 1);
      continue;
    }
    return { line: p.line, lineText: afterText.split(/\r?\n/)[p.line - 1] ?? "", message: p.message };
  }
  return null;
}

/** The first line of `text` that holds a `diagram` header (1-based), and that line. */
function headerLine(text: string): { line: number; lineText: string } {
  const all = text.split(/\r?\n/);
  const at = Math.max(0, all.findIndex((l) => l.trimStart().startsWith("diagram")));
  return { line: at + 1, lineText: all[at] ?? "" };
}

/**
 * Decision 13a: the first problem a landing would leave. Each touched frame's first new error (`wouldBreak` on its
 * own parse; a new frame against none), then the shape cap from the counts alone, without parsing an untouched frame
 * (a cap the board was already past is not new). A new frame's title and the frame cap are refused by
 * `planBoardLanding` before this runs. Lines are the frame's own, 1-based.
 */
export function boardWouldBreak(
  touched: readonly TouchedFrame[],
  plan: BoardPlan,
  board: { titles: readonly string[]; frames: number; shapes: number },
): { frame: string; line: number; lineText: string; message: string } | null {
  let shapes = board.shapes;
  for (const t of touched) {
    const a = plan.after.get(t.title);
    if (!a) continue;
    const broke = wouldBreak(t.slice === null ? { problems: [] } : t.before, a.parse, a.text);
    if (broke) return { frame: t.title, ...broke };
    shapes += a.parse.defined.size - (t.slice === null ? 0 : t.before.defined.size);
  }
  // New frames' titles and the frame cap are planBoardLanding's refusals; the shape cap can still come from the board's
  // own frames growing, as parseBoard counts it (a one-diagram file has none).
  const frames = board.frames + plan.added.length;
  if (frames > 1 && board.shapes <= MAX_BOARD_SHAPES && shapes > MAX_BOARD_SHAPES) {
    const last = plan.added[plan.added.length - 1] ?? plan.touched[plan.touched.length - 1];
    if (last !== undefined) return { frame: last, ...headerLine(plan.after.get(last)?.text ?? ""), message: MESSAGES.tooManyShapes };
  }
  return null;
}

/** `index` and every change that needs it, directly or through others; Reject in review takes all of them. */
export function withDependents(changes: ProposedChange[], index: number): Set<number> {
  const out = new Set([index]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const c of changes) {
      if (!out.has(c.index) && c.dependsOn.some((d) => out.has(d))) {
        out.add(c.index);
        grew = true;
      }
    }
  }
  return out;
}

/** "a", "a and b", "a, b and c". */
function joined(items: string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** Up to three shape names, then "and <n> more shapes". */
function shapeNames(names: string[]): string {
  if (names.length <= 3) return joined(names);
  return `${names.slice(0, 3).join(", ")} and ${plural(names.length - 3, "more shape", "more shapes")}`;
}

/** "a line", "2 lines": the summary's counts. */
const count = (n: number, one: string, many: string) => (n === 1 ? `a ${one}` : plural(n, one, many));

/** One frame's accepted changes, counted for the summary. */
type Tally = {
  added: string[];
  removed: string[];
  addedLines: number;
  removedLines: number;
  addedColumns: number;
  removedColumns: number;
  changedColumns: number;
  renamed: number;
  moved: number;
  relabelled: number;
  newFrame: boolean;
};

const emptyTally = (): Tally => ({ added: [], removed: [], addedLines: 0, removedLines: 0, addedColumns: 0, removedColumns: 0, changedColumns: 0, renamed: 0, moved: 0, relabelled: 0, newFrame: false });

function tally(t: Tally, c: ProposedChange) {
  const { tag, f } = parts(c.op);
  switch (tag) {
    case "add_node":
      t.added.push(f.name as string);
      return;
    case "remove_node":
      t.removed.push(f.target as string);
      return;
    case "add_flow":
      t.addedLines++;
      return;
    case "remove_flow":
      t.removedLines++;
      return;
    case "rename_node":
      t.renamed++;
      return;
    case "move_to_group":
      t.moved++;
      return;
    case "relabel_flow":
      t.relabelled++;
      return;
    case "add_column":
      t.addedColumns++;
      return;
    case "remove_column":
      t.removedColumns++;
      return;
    case "set_column":
      t.changedColumns++;
      return;
    case "add_frame":
      t.newFrame = true;
      return;
    default:
      unknownTag(tag);
  }
}

/** One frame's clauses: "added Ship and 1 line", "removed a column", ... */
function clausesOf(t: Tally): string[] {
  const side = (names: string[], columns: number, lines: number) => {
    const items: string[] = [];
    if (names.length) items.push(shapeNames(names));
    if (columns) items.push(count(columns, "column", "columns"));
    if (lines) items.push(count(lines, "line", "lines"));
    return items.length > 2 ? joined(items) : items.join(" and ");
  };
  const clauses: string[] = [];
  if (t.added.length || t.addedColumns || t.addedLines) clauses.push(`added ${side(t.added, t.addedColumns, t.addedLines)}`);
  if (t.removed.length || t.removedColumns || t.removedLines) clauses.push(`removed ${side(t.removed, t.removedColumns, t.removedLines)}`);
  if (t.renamed) clauses.push(`renamed ${count(t.renamed, "shape", "shapes")}`);
  if (t.moved) clauses.push(`moved ${count(t.moved, "shape", "shapes")}`);
  if (t.relabelled) clauses.push(`relabelled ${count(t.relabelled, "line", "lines")}`);
  if (t.changedColumns) clauses.push(`changed ${count(t.changedColumns, "column", "columns")}`);
  if (clauses.length === 0 && t.newFrame) clauses.push("added an empty diagram");
  return clauses;
}

/**
 * What the assistant says after the accepted changes landed. Changes in more than one frame are told per frame, in
 * the order they first come: "Done. In Checkout flow I added Ship; in Orders ERD I added a column, as one undo step."
 */
export function landedSummary(changes: ProposedChange[], accepted: ReadonlySet<number>): string {
  const byFrame = new Map<string | null, Tally>();
  for (const c of changes) {
    if (!accepted.has(c.index) || c.status.kind !== "ok") continue;
    const { tag, f } = parts(c.op);
    const frame = tag === "add_frame" ? (f.title as string) : (c.frame ?? f.frame ?? null);
    let t = byFrame.get(frame);
    if (!t) byFrame.set(frame, (t = emptyTally()));
    tally(t, c);
  }
  const told = [...byFrame].map(([frame, t]) => ({ frame, clauses: clausesOf(t) })).filter((x) => x.clauses.length > 0);
  if (told.length === 0) return "Done. Nothing changed.";
  const marked = told.some((x) => x.clauses.some((c) => !c.startsWith("removed")));
  const body = told.length === 1 ? `I ${joined(told[0].clauses)}` : told.map((x, i) => `${i === 0 ? "In" : "in"} ${x.frame ?? "this diagram"} I ${joined(x.clauses)}`).join("; ");
  return `Done. ${body}, as one undo step.${marked ? " The new parts are ringed on the canvas for a moment." : ""}`;
}

/** What an Ask asks again after a dropped or unusable set (board 11.5, e-checker); a board Ask says board. */
export const fixQuestion = (messages: string[], board: boolean): string =>
  `Some changes could not be used: ${messages.map((m) => m.replace(/\.$/, "")).join("; ")}. Propose them again so they fit this ${board ? "board" : "diagram"}.`;

/** What one frame's accepted changes remove (see `boardRemovalCount`). */
function removals(changes: readonly ProposedChange[], accepted: ReadonlySet<number>, outline: FlowOutline): { shapes: string[]; columns: string[]; lines: number; tables: string[] } {
  const shapes: string[] = [];
  const columns: string[] = [];
  const goneColumns = new Set<string>();
  const hit = new Set<number>();
  let unmatched = 0;
  for (const c of changes) {
    if (!accepted.has(c.index) || c.status.kind !== "ok") continue;
    const { tag, f } = parts(c.op);
    if (tag === "remove_node") shapes.push(f.target as string);
    else if (tag === "remove_column") {
      columns.push(linkEndText(f.table as string, f.column as string));
      goneColumns.add(`${f.table}\u0000${f.column}`);
    } else if (tag === "remove_flow") {
      const from = outlineEnd(outline, f.from as string);
      const to = outlineEnd(outline, f.to as string);
      const i = outline.links.findIndex((l, k) => !hit.has(k) && linkMatches(l, from, to) && (f.label == null || l.label === f.label));
      if (i < 0) unmatched++;
      else hit.add(i);
    }
  }
  const gone = new Set(shapes);
  const onColumn = (table: string, column: string | undefined) => column !== undefined && goneColumns.has(`${table}\u0000${column}`);
  outline.links.forEach((l, k) => {
    if (gone.has(l.from) || gone.has(l.to) || onColumn(l.from, l.fromColumn) || onColumn(l.to, l.toColumn)) hit.add(k);
  });
  const tables = shapes.filter((s) => outline.nodes.some((n) => n.name === s && n.table));
  return { shapes, columns, lines: hit.size + unmatched, tables };
}

/**
 * What the accepted changes remove, for the confirm: the shapes, the lines (removed directly and those attached to
 * a removed shape, each once) and the removed shapes that have a table.
 */
export function removalCount(changes: ProposedChange[], accepted: ReadonlySet<number>, outline: FlowOutline): { shapes: string[]; lines: number; tables: string[] } {
  const { shapes, lines, tables } = removals(changes, accepted, outline);
  return { shapes, lines, tables };
}

/**
 * What the accepted changes remove across a board's frames, for the confirm (Decision 13b): the shapes, the ER
 * columns (`table.column`), the lines (removed directly, and those on a removed shape or column, each once), the
 * removed shapes with a table, and the frames that lose anything, in board order. Each change counts in its frame.
 */
export function boardRemovalCount(
  changes: ProposedChange[],
  accepted: ReadonlySet<number>,
  frames: readonly { title: string; outline: FlowOutline }[],
): { shapes: string[]; columns: string[]; lines: number; tables: string[]; frames: string[] } {
  const titles = frames.map((f) => f.title);
  const out = { shapes: [] as string[], columns: [] as string[], lines: 0, tables: [] as string[], frames: [] as string[] };
  const seen = new Set<string>();
  for (const frame of frames) {
    if (seen.has(frame.title)) continue;
    seen.add(frame.title);
    const mine = changes.filter((c) => changeFrame(c, titles) === frame.title);
    const r = removals(mine, accepted, frame.outline);
    if (r.shapes.length === 0 && r.columns.length === 0 && r.lines === 0) continue;
    out.shapes.push(...r.shapes);
    out.columns.push(...r.columns);
    out.lines += r.lines;
    out.tables.push(...r.tables);
    out.frames.push(frame.title);
  }
  return out;
}

/** What a saved outcome says under a reloaded card: the landed summary of an Auto-apply, else "Accepted <k> of <n>." */
/**
 * An earlier proposal in one line: what became of it (applied, rejected, partly applied) or that it was not reviewed,
 * with its changes counted as the card's title counts them.
 */
export function foldedOutcome(changes: ProposedChange[], outcome: ToolOutcome | null): string {
  const ok = changes.filter((c) => c.status.kind === "ok").length;
  const title = ok === changes.length ? plural(changes.length, "change", "changes") : `${ok.toLocaleString("en-US")} of ${plural(changes.length, "change", "changes")}`;
  if (!outcome) return `Not reviewed: ${title}.`;
  if (outcome.accepted === 0) return `Rejected: ${title}.`;
  const decided = outcome.accepted + outcome.rejected;
  if (outcome.accepted >= decided) return `Applied: ${title}.`;
  return `Partly applied: ${outcome.accepted.toLocaleString("en-US")} of ${plural(decided, "change", "changes")}.`;
}

export function outcomeText(changes: ProposedChange[], outcome: ToolOutcome): string {
  if (outcome.auto && outcome.accepted > 0) return landedSummary(changes, new Set(changes.filter((c) => c.status.kind === "ok").map((c) => c.index)));
  return `Accepted ${outcome.accepted.toLocaleString("en-US")} of ${(outcome.accepted + outcome.rejected).toLocaleString("en-US")}.`;
}
