// Diagram steps 7 and 8 (boards DiagramMindMap and DiagramSequence): the edits that put a line somewhere else. A mind
// map topic moves with its subtopics, re-indented (drag, Ctrl or Alt+Up/Down), goes beside another (Shift+Tab) or
// goes with its subtopics and relationships (Delete). A sequence message goes in at a row or moves to another, a
// participant's line moves, and a frame is renamed or taken apart. Each reads the parse of the current text and
// changes only the lines it moves; the rest stays byte for byte.
import type { TextEdit } from "../protocol";
import { ARROWS, type FlowArrow, type FlowNode, flowName } from "./model";
import { addLink, indentAt, topicText, insertLine, isBlankLine, lineBreak, lineEnd, lineStart, mindStep, nextLine, normalize, removeLines, removeLinks } from "./edits";
import type { FlowParse } from "./parse";

/** One replace from `text` to `next`: the changed middle only, so untouched lines stay as they were. */
function diffEdit(text: string, next: string): TextEdit[] {
  if (next === text) return [];
  let a = 0;
  while (a < next.length && a < text.length && next[a] === text[a]) a++;
  let b = 0;
  while (b < next.length - a && b < text.length - a && next[next.length - 1 - b] === text[text.length - 1 - b]) b++;
  return [{ from: a, to: text.length - b, insert: next.slice(a, next.length - b) }];
}

/**
 * Removes whole-line ranges and inserts a block of lines at one line start, all planned on `text`, and returns the
 * one edit that makes it. A text with no line break at its end is handled as if it had one, so a moved last line
 * never runs into the line before it.
 */
function moveLines(text: string, removals: readonly { from: number; to: number }[], at: number, block: string): TextEdit[] {
  const nl = lineBreak(text);
  const open = text.length > 0 && !text.endsWith("\n");
  const t = open ? text + nl : text;
  const edits: TextEdit[] = removals.map((r) => ({ from: r.from, to: r.to === text.length && open ? t.length : r.to, insert: "" }));
  edits.push({ from: at === text.length && open ? t.length : at, to: at === text.length && open ? t.length : at, insert: block });
  let out = t;
  for (const e of normalize(t, edits).sort((x, y) => y.from - x.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  if (open && out.endsWith(nl)) out = out.slice(0, out.length - nl.length);
  return diffEdit(text, out);
}

/** The text of lines `[from, to)`, each with `oldIndent` taken off its front and `newIndent` put on, line breaks kept. */
function reindent(text: string, from: number, to: number, oldIndent: number, newIndent: string, nl: string): string {
  let out = "";
  for (let p = from; p < to; p = nextLine(text, p)) {
    const e = lineEnd(text, p);
    const line = text.slice(p, e);
    if (isBlankLine(text, p)) out += line + nl;
    else {
      let k = 0;
      while (k < oldIndent && k < line.length && (line[k] === " " || line[k] === "\t")) k++;
      out += newIndent + line.slice(k) + nl;
    }
    if (nextLine(text, p) <= p) break;
  }
  return out;
}

// ----- mind map (step 7)

/** The mind map's nodes and where `name` is among them; null on a text with errors or for an unknown name. */
function mindNodes(parse: FlowParse): FlowNode[] | null {
  return parse.kind === "mindmap" && parse.doc ? parse.doc.nodes : null;
}

/** The topics under node `at` (its whole branch), by their index in `nodes`; a note ends a branch. */
function branchOf(nodes: readonly FlowNode[], at: number): number[] {
  const depth = nodes[at].depth ?? 0;
  const out: number[] = [];
  for (let i = at + 1; i < nodes.length && nodes[i].kind !== "note" && (nodes[i].depth ?? 0) > depth; i++) out.push(i);
  return out;
}

/** The direct subtopics of node `at`: the shallowest of its branch. */
function childrenOf(nodes: readonly FlowNode[], at: number): number[] {
  const branch = branchOf(nodes, at);
  const least = Math.min(...branch.map((i) => nodes[i].depth ?? 0));
  return branch.filter((i) => (nodes[i].depth ?? 0) === least);
}

/** The lines of a topic and its whole branch: from its line's start to the start of the line after its last subtopic. */
function branchLines(text: string, parse: FlowParse, nodes: readonly FlowNode[], at: number): { from: number; to: number } | null {
  const sp = parse.span(`node:${nodes[at].name}`);
  if (!sp) return null;
  let last = sp.from;
  for (const i of branchOf(nodes, at)) {
    const q = parse.span(`node:${nodes[i].name}`);
    if (q) last = q.from;
  }
  // Comments right after its last subtopic, indented deeper than the topic, belong to the branch (fix round 1, M1).
  const own = indentAt(text, sp.from).length;
  let to = nextLine(text, last);
  while (to < text.length && !isBlankLine(text, to)) {
    const indent = indentAt(text, to);
    if (indent.length <= own || !text.startsWith("//", to + indent.length)) break;
    to = nextLine(text, to);
  }
  return { from: lineStart(text, sp.from), to };
}

/** A new topic after `sibling`'s whole branch, at its indent (Shift+Tab, Mind42). The central idea has no siblings. */
export function addTopicAfter(text: string, parse: FlowParse, name: string, sibling: string, attrs: Record<string, string> = {}): TextEdit[] {
  const nodes = mindNodes(parse);
  const at = nodes ? nodes.findIndex((n) => n.name === sibling) : -1;
  if (!nodes || at < 0 || nodes[at].kind !== "topic") return [];
  const lines = branchLines(text, parse, nodes, at);
  if (!lines) return [];
  return [insertLine(text, lines.to, `${indentAt(text, lines.from)}${topicText(name, attrs)}`, lineBreak(text))];
}

/**
 * Moves topic `name` with its subtopics to be child `index` of `parent` (counted without it), its lines re-indented to
 * the new level, as one edit (XMind, Miro: drag a topic; Mind42: Ctrl+Up/Down). Refused for the central idea, a
 * parent inside its own branch, and where it already is.
 */
export function moveTopic(text: string, parse: FlowParse, name: string, parent: string, index: number): TextEdit[] {
  const nodes = mindNodes(parse);
  if (!nodes || !Number.isInteger(index) || index < 0) return [];
  const a = nodes.findIndex((n) => n.name === name);
  const p = nodes.findIndex((n) => n.name === parent);
  if (a < 0 || p < 0 || nodes[a].kind !== "topic" || a === p) return [];
  const branch = branchOf(nodes, a);
  if (branch.includes(p)) return [];
  const block = branchLines(text, parse, nodes, a);
  const ps = parse.span(`node:${parent}`);
  if (!block || !ps) return [];
  const kids = childrenOf(nodes, p).filter((i) => i !== a);
  const now = childrenOf(nodes, p).indexOf(a);
  if (now >= 0 && now === Math.min(index, kids.length)) return [];
  // Where it goes: before the sibling it is put in front of, else after the parent's branch (itself left out).
  let at: number;
  if (index < kids.length) at = lineStart(text, parse.span(`node:${nodes[kids[index]].name}`)!.from);
  else {
    let last = ps.from;
    for (const i of branchOf(nodes, p)) {
      if (i === a || branch.includes(i)) continue;
      const q = parse.span(`node:${nodes[i].name}`);
      if (q) last = q.from;
    }
    at = nextLine(text, last);
  }
  // At the indent its new siblings use; with none, one step of the file's own indent in from the parent.
  const sib = kids.length ? parse.span(`node:${nodes[kids[0]].name}`) : null;
  const indent = sib ? indentAt(text, sib.from) : `${indentAt(text, ps.from)}${mindStep(text, parse)}`;
  const nl = lineBreak(text);
  const open = text.length > 0 && !text.endsWith("\n");
  const t = open ? text + nl : text;
  const moved = reindent(t, block.from, block.to === text.length ? t.length : block.to, indentAt(text, block.from).length, indent, nl);
  return moveLines(text, [block], at, moved);
}

/** Deletes a topic, its subtopics and every relationship that touches them, as one edit (XMind, Miro). */
export function deleteTopic(text: string, parse: FlowParse, name: string): TextEdit[] {
  const nodes = mindNodes(parse);
  const a = nodes ? nodes.findIndex((n) => n.name === name) : -1;
  if (!nodes || a < 0 || nodes[a].kind !== "topic") return [];
  const block = branchLines(text, parse, nodes, a);
  if (!block) return [];
  const gone = new Set([name, ...branchOf(nodes, a).map((i) => nodes[i].name)]);
  const edits: TextEdit[] = [removeLines(text, block.from, block.to)];
  removeLinks(text, parse, (l) => gone.has(l.from) || gone.has(l.to), edits, lineBreak(text));
  return normalize(text, edits);
}

// ----- sequence (step 8)

/** A frame's lines: its index in the doc, the message range it holds, and the starts of its `{` and `}` lines. */
export interface FrameSpot {
  index: number;
  label: string;
  from: number;
  to: number;
  openLine: number;
  closeLine: number;
}

/** Every closed, non-empty frame of a sequence with the lines of its braces; none on a text with errors. */
export function frameSpots(text: string, parse: FlowParse): FrameSpot[] {
  if (parse.kind !== "sequence" || !parse.doc) return [];
  const out: FrameSpot[] = [];
  (parse.doc.frames ?? []).forEach((f, index) => {
    const sp = parse.span(`frame:${index}`);
    if (!sp?.close || f.to < f.from) return;
    out.push({ index, label: f.label, from: f.from, to: f.to, openLine: lineStart(text, sp.from), closeLine: lineStart(text, sp.close.from) });
  });
  return out;
}

/** The frame a loop around messages `from` to `to` would cut across (a frame holds whole frames), or null. */
export function loopCut(parse: FlowParse, from: number, to: number): string | null {
  for (const f of parse.kind === "sequence" ? (parse.doc?.frames ?? []) : []) {
    if (f.to < f.from) continue;
    if ((f.from < from && f.to >= from && f.to < to) || (f.from > from && f.from <= to && f.to > to)) return f.label;
  }
  return null;
}

/** Why a loop is refused: the frame it would cut across (board DiagramSequence). */
export const LOOP_CUT = (label: string) => `A loop holds whole frames: this one would cut across "${label}". Select from its first to its last message, or inside it.`;

/**
 * Where a message goes to land at row `at`, with message `skip` taken out (a move), so that it is inside exactly the
 * frames that hold both the message above it and the one below it: before the next message, or before the frames that
 * open on it; after the last one, past the frames that close on it. Its line start and the indent there.
 */
function slotSpot(text: string, parse: FlowParse, frames: readonly FrameSpot[], at: number, skip: number): { pos: number; indent: string } | null {
  const n = parse.links.length;
  const next = at === skip ? at + 1 : at;
  const prev = at - 1 === skip ? at - 2 : at - 1;
  if (next < n) {
    const line = parse.span(`link:${next}`)?.line;
    if (!line) return null;
    let pos = lineStart(text, line.from);
    for (const f of frames) if (f.from === next && f.to >= next && !(f.from === skip && f.to === skip) && f.openLine < pos) pos = f.openLine;
    return { pos, indent: indentAt(text, pos) };
  }
  if (prev < 0) return null;
  const line = parse.span(`link:${prev}`)?.line;
  if (!line) return null;
  let last = lineStart(text, line.from);
  for (const f of frames) if (f.to === prev && f.closeLine > last) last = f.closeLine;
  return { pos: nextLine(text, last), indent: indentAt(text, last) };
}

/** The statement of message `index` alone on its line (with any comment after it), or null for a chain. */
function messageLine(text: string, parse: FlowParse, index: number): { from: number; to: number; statement: string } | null {
  const sp = parse.span(`link:${index}`);
  if (!sp?.line) return null;
  const from = lineStart(text, sp.line.from);
  for (const k of [index - 1, index + 1]) if (parse.span(`link:${k}`)?.line?.from === sp.line.from) return null;
  let end = lineEnd(text, sp.line.from);
  while (end > sp.line.from && /\s/.test(text[end - 1])) end--;
  return { from, to: nextLine(text, sp.line.from), statement: text.slice(sp.line.from, end) };
}

/**
 * A message from `from` to `to` put at row `at` (0 is above the first), where it was drawn (Visio, Software Ideas
 * Modeler). With `inside`, it goes just after message `at - 1`, inside every frame that holds it (Add reply below).
 */
export function addMessage(text: string, parse: FlowParse, from: string, to: string, at: number, arrow: FlowArrow, inside: boolean): TextEdit[] {
  if (parse.kind !== "sequence" || !parse.defined.has(from) || !parse.defined.has(to) || !ARROWS.sequence.includes(arrow)) return [];
  const n = parse.links.length;
  if (!Number.isInteger(at) || at < 0 || at > n) return [];
  if (n === 0) return addLink(text, parse, from, to, arrow);
  const nl = lineBreak(text);
  const line = `${flowName(from)} ${arrow} ${flowName(to)}`;
  if (inside && at > 0) {
    const above = parse.span(`link:${at - 1}`)?.line;
    if (!above) return [];
    return [insertLine(text, nextLine(text, above.from), indentAt(text, above.from) + line, nl)];
  }
  // Between two links written on one line (`A -> B -> C`): the line is split there, so it lands on its row (M5).
  const here = at < n ? parse.span(`link:${at}`) : null;
  const before = at > 0 ? parse.span(`link:${at - 1}`) : null;
  if (here?.line && before?.line && here.line.from === before.line.from && before.toName) {
    const indent = indentAt(text, here.line.from);
    const again = text.slice(before.toName.from, before.toName.to);
    return [{ from: before.toName.to, to: before.toName.to, insert: `${nl}${indent}${line}${nl}${indent}${again}` }];
  }
  const spot = slotSpot(text, parse, frameSpots(text, parse), at, -1);
  return spot ? [insertLine(text, spot.pos, spot.indent + line, nl)] : [];
}

/** Why a message cannot move on its own: it shares its line with others (fix round 1, I3); null when it can. */
export function chainNote(text: string, parse: FlowParse, index: number): string | null {
  const sp = parse.span(`link:${index}`);
  if (!sp?.line || messageLine(text, parse, index)) return null;
  let end = lineEnd(text, sp.line.from);
  while (end > sp.line.from && /\s/.test(text[end - 1])) end--;
  return `This message shares its line with others (${text.slice(sp.line.from, end)}). Split the line in the text to move it on its own.`;
}

/**
 * Message `index` moved to row `at` (counted before the move; `index` and `index + 1` are where it is). It joins the
 * frames that hold both its new neighbours and leaves the others; a frame it leaves empty goes (board DiagramSequence).
 */
export function moveMessage(text: string, parse: FlowParse, index: number, at: number): TextEdit[] {
  const n = parse.links.length;
  if (parse.kind !== "sequence" || !parse.doc || !Number.isInteger(index) || !Number.isInteger(at) || index < 0 || index >= n || at < 0 || at > n || at === index || at === index + 1) return [];
  const msg = messageLine(text, parse, index);
  if (!msg) return [];
  const frames = frameSpots(text, parse);
  const spot = slotSpot(text, parse, frames, at, index);
  if (!spot) return [];
  const removals = [{ from: msg.from, to: msg.to }];
  for (const f of frames) {
    if (f.from !== index || f.to !== index) continue;
    removals.push({ from: f.openLine, to: nextLine(text, f.openLine) }, { from: f.closeLine, to: nextLine(text, f.closeLine) });
  }
  return moveLines(text, removals, spot.pos, `${spot.indent}${msg.statement}${lineBreak(text)}`);
}

/**
 * Participant `name` moved to just before `before` (null: last), as Visio and draw.io drag a lifeline. Declared
 * participants: its line moves. When some are named only by their messages, every participant is written out, in the
 * new order, where the first declaration was.
 */
export function moveParticipant(text: string, parse: FlowParse, name: string, before: string | null): TextEdit[] {
  const doc = parse.kind === "sequence" ? parse.doc : null;
  if (!doc) return [];
  const order = doc.nodes.filter((n) => n.kind === "participant" || n.kind === "actor").map((n) => n.name);
  if (!order.includes(name) || before === name || (before !== null && !order.includes(before))) return [];
  const next = order.filter((n) => n !== name);
  next.splice(before === null ? next.length : next.indexOf(before), 0, name);
  if (next.every((n, i) => n === order[i])) return [];
  const nl = lineBreak(text);
  const declared = (n: string) => parse.span(`node:${n}`);
  const statementOf = (n: string) => {
    const sp = declared(n)!;
    let end = lineEnd(text, sp.from);
    while (end > sp.from && /\s/.test(text[end - 1])) end--;
    return text.slice(sp.from, end);
  };
  if (order.every((n) => declared(n))) {
    const own = declared(name)!;
    const rest = before ?? next[next.length - 2];
    const ref = declared(rest)!;
    const at = before !== null ? lineStart(text, ref.from) : nextLine(text, ref.from);
    return moveLines(text, [{ from: lineStart(text, own.from), to: nextLine(text, own.from) }], at, `${indentAt(text, own.from)}${statementOf(name)}${nl}`);
  }
  const lines = order.filter((n) => declared(n)).map((n) => ({ from: lineStart(text, declared(n)!.from), to: nextLine(text, declared(n)!.from) }));
  const header = parse.span("diagram");
  const at = lines.length ? Math.min(...lines.map((l) => l.from)) : header ? nextLine(text, header.from) : 0;
  const block = next.map((n) => (declared(n) ? statementOf(n) : `participant ${flowName(n)}`)).join(nl) + nl;
  return moveLines(text, lines, at, block);
}

/** A frame's label (after its kind word) written in place; the frame is named by its index and the label seen there. */
export function setFrameLabel(_text: string, parse: FlowParse, index: number, was: string, label: string): TextEdit[] {
  const f = parse.kind === "sequence" ? parse.doc?.frames?.[index] : undefined;
  const sp = parse.span(`frame:${index}`);
  const value = label.trim();
  if (!f || !sp?.name || f.label !== was || !value || /[{}\r\n]/.test(value)) return [];
  if (`${f.kind} ${value}` === f.label) return [];
  const empty = sp.name.from === sp.name.to;
  return [{ from: sp.name.from, to: sp.name.to, insert: empty ? `${value} ` : value }];
}

/** Takes a frame apart (Delete on a loop): its two brace lines go, its messages come out one level, and stay. */
export function unwrapFrame(text: string, parse: FlowParse, index: number, was: string): TextEdit[] {
  const f = frameSpots(text, parse).find((x) => x.index === index);
  if (!f || f.label !== was) return [];
  const edits: TextEdit[] = [removeLines(text, f.openLine, nextLine(text, f.openLine)), removeLines(text, f.closeLine, nextLine(text, f.closeLine))];
  const own = indentAt(text, f.openLine).length;
  const inside: number[] = [];
  for (let p = nextLine(text, f.openLine); p < f.closeLine; p = nextLine(text, p)) if (!isBlankLine(text, p)) inside.push(p);
  const extra = Math.min(...inside.map((p) => indentAt(text, p).length - own));
  if (Number.isFinite(extra) && extra > 0) for (const p of inside) edits.push({ from: p + own, to: p + own + extra, insert: "" });
  return normalize(text, edits);
}
