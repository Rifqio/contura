// Canvas actions as text edits (spec section 2, "Edits from the canvas"). Each function reads the parse of the
// current text, so it works while the text has errors, and returns the smallest change: untouched lines stay
// byte for byte. In the app they run in the language worker against its cached parse (ruling P5).
import type { TextEdit } from "../protocol";
import { isColourValue } from "./colours";
import {
  ARROWS,
  LINE_COLOUR_DIAGRAMS,
  ATTR_KEYS,
  attrItems,
  attrValue,
  type ColumnFlag,
  COLUMN_FLAGS,
  columnFlagsText,
  columnTypeText,
  type DiagramKind,
  type FlowArrow,
  type FlowAttrKey,
  type FlowLink,
  type FlowNodeKind,
  flowLabel,
  flowName,
  isColumnName,
  linkEndText,
  needsQuotes,
  nodeStatement,
  sqlFreeName,
  isStateMarker,
  isStateStart,
  STATE_END,
  STATE_START,
} from "./model";
import { addMessage, addTopicAfter, chainNote, deleteTopic, frameSpots, LOOP_CUT, loopCut, moveMessage, moveParticipant, moveTopic, setFrameLabel, unwrapFrame } from "./orderEdits";
import { type FlowParse, type FlowRange, type FlowSpan, parseFlow, type RowSpan } from "./parse";
import { longestPrefix, MAX_PREFIX_DOTS } from "./erMigrate";

/** One canvas action, as the worker is asked for it. */
export type FlowEditOp =
  | {
      op: "addNode";
      name: string;
      /** Null leaves the kind unsaid (a flowchart step, a cloud service). */
      kind: FlowNodeKind | null;
      attrs?: Record<string, string>;
      group?: string | null;
      /** Makes the name unique first (`Process 3`), so a quick add never collides. */
      unique?: boolean;
      /** Writes the line just before this node's (a sequence participant added between two); else at the usual place. */
      before?: string;
      /** A timeline item's date, and a period's end (step 6: the date comes from where you clicked). */
      date?: string;
      until?: string;
      /** A mind map topic's parent: the line goes after the parent's branch, one level in. */
      under?: string;
      /** A mind map topic's sibling (Shift+Tab, step 7): the line goes after that topic's branch, at its indent. */
      after?: string;
    }
  | {
      op: "addGroup";
      name: string;
      /** The group to put it in; null or absent puts it outside every group. */
      group?: string | null;
      unique?: boolean;
    }
  // An ER relationship's end may be a column of its table (`orders.customer_id`); without one it joins the whole table.
  | { op: "addLink"; from: string; to: string; arrow: FlowArrow; label?: string; fromColumn?: string; toColumn?: string }
  | { op: "renameNode"; old: string; next: string }
  | { op: "deleteNode"; name: string }
  | { op: "moveToGroup"; name: string; group: string | null }
  | { op: "setAttr"; name: string; key: "kind" | FlowAttrKey; value: string | null }
  // Step 11: a line's colour by its ref (`A > B: no [color: warning]`); null clears it.
  | { op: "setLinkColor"; link: LinkRef; color: string | null }
  // A line's label by its ref (the in-place field), as the line ops find their line.
  | { op: "setLinkLabel"; index: number; label: string | null; link?: LinkRef }
  | { op: "deleteLink"; index: number }
  // A line's arrow, direction and ends (diagram step 4, F8 and CL2).
  | { op: "setLinkArrow"; link: LinkRef; arrow: FlowArrow }
  | { op: "reverseLink"; link: LinkRef }
  | { op: "setLinkEnd"; link: LinkRef; end: "from" | "to"; node: string; column?: string }
  // ER columns, by their index in the table's rows and the name the canvas saw there: a text that no longer has that
  // column at that place (a stale drawing) refuses the op.
  | { op: "addColumn"; table: string; at: number; before: string | null; name: string; type: string; flags?: ColumnFlag[] }
  | { op: "setColumn"; table: string; index: number; column: string; name?: string; type?: string }
  | { op: "setColumnFlag"; table: string; index: number; column: string; flag: ColumnFlag; on: boolean }
  | { op: "duplicateColumn"; table: string; index: number; column: string }
  | { op: "deleteColumn"; table: string; index: number; column: string }
  // Diagram step 3, CL1: a class's members as rows, by their place and the text the canvas saw there.
  | { op: "addMember"; owner: string; at: number; member: string }
  | { op: "setMember"; owner: string; index: number; was: string; member: string }
  | { op: "duplicateMember"; owner: string; index: number; was: string }
  | { op: "deleteMember"; owner: string; index: number; was: string }
  // T1: a timeline event's date, or a period's two dates.
  | { op: "setDate"; name: string; date: string; until?: string }
  // Step 6, D1: a group's braces go and what it held moves out one level (Ctrl+Shift+G, Ctrl+Shift+U).
  | { op: "ungroup"; name: string }
  // Step 9, F9: a group's whole block with everything in it and every line to what it held (Delete with contents).
  | { op: "deleteGroup"; name: string }
  // Step 6, F18: the Shapes items that are not plain shapes: a sequence's activation and loop, a timeline's section.
  | { op: "addActivation"; name: string }
  | { op: "addLoop"; label: string; from: number; to: number }
  | { op: "addSection"; name: string; members: string[] }
  // Step 7: a mind map topic with its subtopics moved to child `index` of `parent` (drag, Ctrl or Alt+Up/Down), or
  // deleted with them and every relationship that touches them.
  | { op: "moveTopic"; name: string; parent: string; index: number }
  | { op: "deleteTopic"; name: string }
  // Step 8: a message put at row `at` (S1); `inside` keeps it in the frames of the message above it (Add reply below).
  | { op: "addMessage"; from: string; to: string; at: number; arrow?: FlowArrow; inside?: boolean }
  | { op: "moveMessage"; index: number; at: number }
  | { op: "moveParticipant"; name: string; before: string | null }
  // A frame by its index in the doc's frames and the label the canvas saw there (`loop every item`).
  | { op: "setFrameLabel"; index: number; was: string; label: string }
  | { op: "unwrapFrame"; index: number; was: string };

/**
 * The edits, and for an add the name it used (a paste: each pasted name's new name). An empty list means the action
 * does not apply to this text.
 */
export type FlowEditResult = {
  edits: TextEdit[];
  name?: string;
  names?: Record<string, string>;
  /** A paste: why it was refused (no edits), or what it left out. */
  note?: string;
};

// ----- text helpers

const isBlankChar = (c: string) => c === " " || c === "\t";
const isSpace = (c: string) => /\s/.test(c);

/** The text's own line break, so a CRLF file stays CRLF. */
export function lineBreak(s: string): string {
  const i = s.indexOf("\n");
  return i > 0 && s[i - 1] === "\r" ? "\r\n" : "\n";
}

export const lineStart = (s: string, p: number) => s.lastIndexOf("\n", p - 1) + 1;

/** The end of the line holding `p`, before its line break. */
export function lineEnd(s: string, p: number): number {
  let e = s.indexOf("\n", p);
  if (e < 0) return s.length;
  if (e > p && s[e - 1] === "\r") e--;
  return e;
}

/** The start of the line after the one holding `p`, or the end of the text. */
export function nextLine(s: string, p: number): number {
  const e = s.indexOf("\n", p);
  return e < 0 ? s.length : e + 1;
}

export function indentAt(s: string, p: number): string {
  const a = lineStart(s, p);
  let b = a;
  while (b < s.length && isBlankChar(s[b])) b++;
  return s.slice(a, b);
}

/** Where a `//` comment starts after `p` on the same line, or -1. */
function commentAfter(s: string, p: number): number {
  const e = lineEnd(s, p);
  let q = p;
  while (q < e && isBlankChar(s[q])) q++;
  return q + 1 < e && s[q] === "/" && s[q + 1] === "/" ? q : -1;
}

export function isBlankLine(s: string, start: number): boolean {
  const e = lineEnd(s, start);
  for (let i = start; i < e; i++) if (!isSpace(s[i])) return false;
  return true;
}

/** Deletes whole lines `[from, to)`; when blank lines sit on both sides, one of them goes too. */
export function removeLines(s: string, from: number, to: number): TextEdit {
  if (to >= s.length && !s.endsWith("\n") && from > 0) {
    // The last line has no line break: take the one before it instead.
    let f = from - 1;
    if (f > 0 && s[f - 1] === "\r") f--;
    return { from: f, to: s.length, insert: "" };
  }
  if (from > 0 && to < s.length && isBlankLine(s, lineStart(s, from - 1)) && isBlankLine(s, to)) {
    return { from, to: nextLine(s, to), insert: "" };
  }
  return { from, to, insert: "" };
}

/** Deletes a statement's line; a comment after it stays, where it was. */
function removeStatement(s: string, from: number, to: number): TextEdit {
  const c = commentAfter(s, to);
  if (c >= 0) return { from, to: c, insert: "" };
  return removeLines(s, lineStart(s, from), nextLine(s, from));
}

/** A line inserted at the start of a line (or at the end of the text). */
export function insertLine(s: string, pos: number, line: string, nl: string): TextEdit {
  if (pos >= s.length && s.length > 0 && !s.endsWith("\n")) return { from: s.length, to: s.length, insert: nl + line };
  return { from: pos, to: pos, insert: line + nl };
}

/** Sorted and merged where edits touch, so the list is valid as one CodeMirror change. */
export function normalize(s: string, edits: TextEdit[]): TextEdit[] {
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => a.e.from - b.e.from || a.e.to - b.e.to || a.i - b.i);
  const out: TextEdit[] = [];
  for (const { e } of sorted) {
    const cur = out[out.length - 1];
    if (cur && e.from <= cur.to) {
      if (e.to > cur.to) cur.to = e.to;
      cur.insert += e.insert;
    } else {
      out.push({ ...e });
    }
  }
  return out.filter((e) => s.slice(e.from, e.to) !== e.insert);
}

// ----- where new lines go

/**
 * After the last node that is in no group, past its own lines (a class's members, an ER table's block to its `}`);
 * else after the first line; else at the end.
 */
function topLevelSpot(s: string, parse: FlowParse, except?: string): number {
  let at = -1;
  for (const name of parse.defined.keys()) {
    if (name === except || parse.parentOf(name) !== null) continue;
    const sp = parse.span(`node:${name}`);
    if (!sp) continue;
    at = sp.from;
    for (const row of parse.rowsOf(name)) if (row.line.from > at) at = row.line.from;
    const close = parse.span(`table:${name}`)?.close;
    if (close && close.from > at) at = close.from;
  }
  if (at >= 0) return nextLine(s, at);
  const header = parse.span("diagram");
  return header ? nextLine(s, header.from) : s.length;
}

/** Just before the group's `}`, one level in; at the end when the `}` is missing. */
function groupSpot(s: string, parse: FlowParse, group: string): { pos: number; indent: string } | null {
  const sp = parse.span(`group:${group}`);
  if (!sp) return null;
  const indent = `${indentAt(s, sp.from)}  `;
  return { pos: sp.close ? lineStart(s, sp.close.from) : s.length, indent };
}

export function nodeText(name: string, kind: FlowNodeKind | null, attrs: Record<string, string>, diagram: DiagramKind | null): string {
  // Step 12 kinds write their own statement (participant App, class Invoice, a dated timeline line, an indent).
  if (kind && diagram && diagram !== "dfd" && diagram !== "flow" && diagram !== "cloud") return nodeStatement(diagram, { name, kind, attrs });
  if (kind === "note") return nodeStatement(diagram, { name, kind, attrs, text: name });
  const parts: string[] = kind && !(kind === "service" && diagram === "cloud") ? [kind] : [];
  parts.push(...attrItems(attrs));
  return parts.length ? `${flowName(name)} [${parts.join(", ")}]` : flowName(name);
}

// ----- the edits

/** A mind map topic's words on its line: its name, and its `label:` and `color:` when it has them (step 11). */
export function topicText(name: string, attrs: Record<string, string>): string {
  const items = attrItems(attrs);
  return `${flowName(name)}${items.length ? ` [${items.join(", ")}]` : ""}`;
}

/** A new node line, after the loose nodes or inside `group`. Refused (no edits) when the name is taken. */
export function addNode(
  text: string,
  parse: FlowParse,
  name: string,
  kind: FlowNodeKind | null,
  attrs: Record<string, string> = {},
  group?: string | null,
  before?: string,
  more: { date?: string; until?: string; under?: string; after?: string } = {},
): TextEdit[] {
  if (parse.defined.has(name)) return [];
  const nl = lineBreak(text);
  // A mind map topic under its parent: after the parent's whole branch, one level further in.
  if (more.under !== undefined && parse.kind === "mindmap") return addTopicUnder(text, parse, name, more.under, attrs);
  // Or beside a topic (Shift+Tab, step 7): after its whole branch, at its indent.
  if (more.after !== undefined && parse.kind === "mindmap") return addTopicAfter(text, parse, name, more.after, attrs);
  const line =
    parse.kind === "timeline" && kind && (more.date !== undefined || more.until !== undefined)
      ? nodeStatement("timeline", { name, kind, attrs, date: more.date, until: more.until })
      : nodeText(name, kind, attrs, parse.kind);
  const next = before !== undefined && !group ? parse.span(`node:${before}`) : null;
  if (next) return [insertLine(text, lineStart(text, next.from), indentAt(text, next.from) + line, nl)];
  if (group) {
    const spot = groupSpot(text, parse, group);
    return spot ? [insertLine(text, spot.pos, spot.indent + line, nl)] : [];
  }
  return [insertLine(text, topLevelSpot(text, parse), line, nl)];
}

/**
 * A new empty group, `name {` and `}` on their own lines, after the loose nodes or inside `group`. Nodes join it by
 * `moveToGroup` (the canvas sends both as one batch). Refused (no edits) when the name is taken.
 */
export function addGroup(text: string, parse: FlowParse, name: string, group?: string | null): TextEdit[] {
  if (parse.defined.has(name)) return [];
  const nl = lineBreak(text);
  // An ER group says so: a block of tables would otherwise read as a table.
  const open = `${parse.kind === "er" ? "group " : ""}${flowName(name)} {`;
  if (group) {
    const spot = groupSpot(text, parse, group);
    return spot ? [insertLine(text, spot.pos, `${spot.indent}${open}${nl}${spot.indent}}`, nl)] : [];
  }
  return [insertLine(text, topLevelSpot(text, parse), `${open}${nl}}`, nl)];
}

/**
 * A new link line after the last link that sits where this one may: outside every group, or in the group that
 * holds both ends. With no such link it goes at the end, after a blank line.
 */
export function addLink(text: string, parse: FlowParse, from: string, to: string, arrow: FlowArrow, label?: string, fromColumn?: string, toColumn?: string): TextEdit[] {
  const nl = lineBreak(text);
  if (addLinkNote(text, parse, from, to, arrow, fromColumn, toColumn) !== null) return [];
  // A state diagram's start and end markers are written `[*]` (ST1).
  const endOf = (n: string, column?: string) => (parse.kind === "state" && isStateMarker(n) ? "[*]" : linkEndText(n, column));
  const line = `${endOf(from, fromColumn)} ${arrow} ${endOf(to, toColumn)}${label ? `: ${flowLabel(label)}` : ""}`;
  // A composite's own [*] is read only inside its braces (diag-910 fix round 1, I4): the line goes before its }.
  const own = parse.kind === "state" ? [from, to].find((n) => isStateMarker(n) && n !== STATE_START && n !== STATE_END) : undefined;
  if (own !== undefined) {
    const spot = groupSpot(text, parse, parse.parentOf(own) ?? "");
    return spot ? [insertLine(text, spot.pos, spot.indent + line, nl)] : [];
  }
  const shared = parse.parentOf(from) ?? null;
  const home = shared !== null && (parse.parentOf(to) ?? null) === shared ? shared : null;
  const last = lastLinkIn(parse, home);
  if (last) return [insertLine(text, nextLine(text, last.from), indentAt(text, last.from) + line, nl)];
  const end = text.length;
  if (end === 0 || text.endsWith(`${nl}${nl}`) || text.endsWith("\n\n")) return [{ from: end, to: end, insert: line + nl }];
  return [{ from: end, to: end, insert: text.endsWith("\n") ? nl + line + nl : nl + nl + line }];
}

/** The statement of the last link written directly in `group` (null: outside every group). */
export function lastLinkIn(parse: FlowParse, group: string | null): FlowRange | undefined {
  if (parse.links.length === 0) return undefined;
  // Group blocks, so a link's innermost group is the latest-starting block that holds it.
  const blocks: { name: string; from: number; to: number }[] = [];
  for (const name of parse.defined.keys()) {
    const sp = parse.span(`group:${name}`);
    if (sp) blocks.push({ name, from: sp.from, to: sp.to });
  }
  for (let i = parse.links.length - 1; i >= 0; i--) {
    const line = parse.span(`link:${i}`)?.line;
    if (!line) continue;
    let inner: { name: string; from: number } | null = null;
    for (const b of blocks) if (b.from <= line.from && line.from < b.to && (!inner || b.from > inner.from)) inner = b;
    if ((inner?.name ?? null) === group) return line;
  }
  return undefined;
}

/** Renames a node or group and every link end that uses it, quoting the new name when it needs it. */
export function renameNode(text: string, parse: FlowParse, old: string, next: string): TextEdit[] {
  // A name defined twice is already a problem; which one the links mean is unclear, so this does not apply.
  if (old === next || parse.defined.has(next) || parse.definedTwice.has(old)) return [];
  // A note's text runs to the end of its line (`note: ask legal, then sign`), so it is written as a label is.
  const insert = parse.kindOf(old) === "note" ? flowLabel(next) : flowName(next);
  const edits: TextEdit[] = [];
  const seen = new Set<number>();
  const add = (r: FlowRange | undefined) => {
    if (!r || seen.has(r.from)) return;
    seen.add(r.from);
    edits.push({ from: r.from, to: r.to, insert });
  };
  if (erRenameNote(text, parse, old, next) !== null) return [];
  add((parse.span(`node:${old}`) ?? parse.span(`group:${old}`))?.name);
  // Its own extra lines (class members) name it too.
  for (const row of parse.rowsOf(old)) add(row.name);
  // An ER relationship's column end (`invoices.customer_id`) keeps its column: only the table's part changes.
  const tablePart = (r: FlowRange | undefined, column: string | undefined) => {
    if (!r || column === undefined) return r;
    const to = r.to - column.length - 1;
    return text.slice(r.from, to) === old ? { from: r.from, to } : undefined;
  };
  parse.links.forEach((l, i) => {
    if (l.from !== old && l.to !== old) return;
    const sp = parse.span(`link:${i}`);
    // In a chain or a fan, one name is the end of several links: `seen` writes it once.
    if (l.from === old) add(tablePart(sp?.fromName, l.fromColumn));
    if (l.to === old) add(tablePart(sp?.toName, l.toColumn));
  });
  return normalize(text, edits);
}

/**
 * Deletes a node line and every link to or from it; a chain keeps its other links. Comments stay. A group the
 * node leaves empty loses its braces.
 */
export function deleteNode(text: string, parse: FlowParse, name: string): TextEdit[] {
  const sp = parse.span(`node:${name}`);
  if (!sp || parse.definedTwice.has(name)) return [];
  const nl = lineBreak(text);
  const gone = new Set([name]);
  // An ER table's block goes whole, its columns and their comments with it.
  const block = tableBlock(text, parse, name);
  const removals: TextEdit[] = [block ? removeLines(text, block.from, block.to) : removeStatement(text, sp.from, sp.to)];
  // A class's members go with it.
  if (!block) for (const row of parse.rowsOf(name)) removals.push(removeStatement(text, row.line.from, row.line.to));
  removeLinks(text, parse, (l) => gone.has(l.from) || gone.has(l.to), removals, nl);
  // The group it leaves keeps its braces even when empty: it stays drawn where it was (board DiagramGroups; diag-910
  // fix round 2, N7), as when the shape is dragged out.
  return normalize(text, removals);
}

/** Removes the links `drop` picks (by link and index); a chain statement is rewritten as the runs it keeps, one per line. */
export function removeLinks(s: string, parse: FlowParse, drop: (link: FlowLink, index: number) => boolean, edits: TextEdit[], nl: string) {
  const links = parse.links;
  let i = 0;
  while (i < links.length) {
    const first = parse.span(`link:${i}`);
    const line = first?.line;
    let j = i + 1;
    while (j < links.length && line && parse.span(`link:${j}`)?.line?.from === line.from) j++;
    const keep: boolean[] = [];
    for (let k = i; k < j; k++) keep.push(!drop(links[k], k));
    if (line && keep.some((x) => !x)) {
      if (!keep.some((x) => x)) {
        edits.push(removeStatement(s, line.from, line.to));
      } else if (isFan(parse, i, j)) {
        edits.push(keepFanLinks(s, parse, i, keep, line, nl));
      } else {
        const runs: string[] = [];
        let k = 0;
        while (k < keep.length) {
          if (!keep[k]) {
            k++;
            continue;
          }
          let m = k;
          while (m + 1 < keep.length && keep[m + 1]) m++;
          const a = parse.span(`link:${i + k}`)?.fromName;
          const b = m === keep.length - 1 ? line.to : parse.span(`link:${i + m}`)?.toName?.to;
          if (a && b !== undefined) runs.push(s.slice(a.from, b));
          k = m + 1;
        }
        edits.push({ from: line.from, to: line.to, insert: runs.join(nl + indentAt(s, line.from)) });
      }
    }
    i = j;
  }
}

/** True when links `a` to `b` (one statement) are a fan: more links than arrows (`A > B, C`). */
function isFan(parse: FlowParse, a: number, b: number): boolean {
  const arrows = new Set<number>();
  for (let k = a; k < b; k++) arrows.add(parse.span(`link:${k}`)?.arrow?.from ?? -1);
  return b - a > arrows.size;
}

/** The distinct ranges, in text order, among the given ones (one fan list's names). */
function distinctRanges(ranges: (FlowRange | undefined)[]): FlowRange[] {
  const out = new Map<number, FlowRange>();
  for (const r of ranges) if (r && !out.has(r.from)) out.set(r.from, r);
  return [...out.values()].sort((x, y) => x.from - y.from);
}

/** A list rewritten with only the names `kept` picks, each joined to the one before by the separator written before it. */
function keepInList(s: string, list: FlowRange[], kept: (r: FlowRange) => boolean): TextEdit | null {
  if (list.every(kept)) return null;
  const out: string[] = [];
  list.forEach((r, k) => {
    if (!kept(r)) return;
    if (out.length) out.push(s.slice(list[k - 1].to, r.from));
    out.push(s.slice(r.from, r.to));
  });
  return { from: list[0].from, to: list[list.length - 1].to, insert: out.join("") };
}

/**
 * The fan statement holding links `first` onward, written with only the links `keep` marks. With one arrow and kept
 * links that still make every pair of their ends, the dropped names come out of their lists in place; otherwise the
 * statement becomes one statement per kept link.
 */
function keepFanLinks(s: string, parse: FlowParse, first: number, keep: boolean[], line: FlowRange, nl: string): TextEdit {
  const spans = keep.map((_, k) => parse.span(`link:${first + k}`)!);
  const kept = spans.filter((_, k) => keep[k]);
  if (keptInLists(spans, keep)) {
    const froms = new Set(kept.map((sp) => sp.fromName?.from));
    const tos = new Set(kept.map((sp) => sp.toName?.from));
    const left = keepInList(s, distinctRanges(spans.map((sp) => sp.fromName)), (r) => froms.has(r.from));
    const right = keepInList(s, distinctRanges(spans.map((sp) => sp.toName)), (r) => tos.has(r.from));
    if (left && right) return joinEdits(s, left, right);
    return (left ?? right)!;
  }
  const statements = keep.flatMap((k, n) => (k ? [linkStatement(s, parse, first + n)] : []));
  return { from: line.from, to: line.to, insert: statements.join(nl + indentAt(s, line.from)) };
}

/** True when a fan with one arrow keeps links that still make every pair of their ends, so names leave their lists in place. */
function keptInLists(spans: FlowSpan[], keep: boolean[]): boolean {
  const kept = spans.filter((_, k) => keep[k]);
  const arrows = new Set(spans.map((sp) => sp.arrow?.from));
  const froms = new Set(kept.map((sp) => sp.fromName?.from));
  const tos = new Set(kept.map((sp) => sp.toName?.from));
  return arrows.size === 1 && kept.length === froms.size * tos.size;
}

/** Two edits in text order, close together, as one replace from the first to the second. */
function joinEdits(s: string, a: TextEdit, b: TextEdit): TextEdit {
  return { from: a.from, to: b.to, insert: a.insert + s.slice(a.to, b.from) + b.insert };
}

/**
 * Link `index` written as a statement of its own: its names and arrow as written (or as `next` gives them), and its
 * label and attributes when its segment has them (`label` and `attrs` replace them; null leaves them out).
 */
function linkStatement(s: string, parse: FlowParse, index: number, next: { from?: string; arrow?: string; to?: string; label?: string | null; attrs?: string | null } = {}): string {
  const sp = parse.span(`link:${index}`)!;
  const slice = (r: FlowRange | undefined) => (r ? s.slice(r.from, r.to) : "");
  const label = next.label !== undefined ? next.label : sp.label ? slice(sp.label) : null;
  const attrs = next.attrs !== undefined ? next.attrs : sp.attrs ? slice(sp.attrs) : null;
  return `${next.from ?? slice(sp.fromName)} ${next.arrow ?? slice(sp.arrow)} ${next.to ?? slice(sp.toName)}${label !== null ? `: ${label}` : ""}${attrs !== null ? ` ${attrs}` : ""}`;
}

/** The fan statement holding link `index` (its first link, and how many), or null when the link is not in a fan. */
function fanOf(parse: FlowParse, index: number): { first: number; count: number } | null {
  const chain = chainOf(parse, index);
  if (chain.length <= 1 || !isFan(parse, chain[0], chain[chain.length - 1] + 1)) return null;
  return { first: chain[0], count: chain.length };
}

/**
 * Takes link `index` out of its fan statement and writes it as `statement` on its own line just below, with the
 * statement's indent: the others keep what they say. One change, so one undo takes it back.
 */
function splitFanLink(s: string, parse: FlowParse, index: number, fan: { first: number; count: number }, statement: string): TextEdit[] {
  const line = parse.span(`link:${index}`)!.line!;
  const nl = lineBreak(s);
  const keep = Array.from({ length: fan.count }, (_, k) => fan.first + k !== index);
  const spans = keep.map((_, k) => parse.span(`link:${fan.first + k}`)!);
  if (!keptInLists(spans, keep)) {
    // The statement is written one link per line anyway: this link keeps its place among them.
    const statements = keep.map((k, n) => (k ? linkStatement(s, parse, fan.first + n) : statement));
    return [{ from: line.from, to: line.to, insert: statements.join(nl + indentAt(s, line.from)) }];
  }
  const edits = [keepFanLinks(s, parse, fan.first, keep, line, nl), insertLine(s, nextLine(s, line.to), indentAt(s, line.from) + statement, nl)];
  const merged = normalize(s, edits);
  if (merged.length <= 1) return merged;
  // The two edits sit on the same line or the next.
  return [joinEdits(s, merged[0], merged[1])];
}

/** Moves a node line into `group`, or out of every group with null. Its comment goes with it. */
export function moveToGroup(text: string, parse: FlowParse, name: string, group: string | null): TextEdit[] {
  if (!parse.span(`node:${name}`) && parse.span(`group:${name}`)) return moveGroupBlock(text, parse, name, group);
  if (tableBlock(text, parse, name)) return moveGroupBlock(text, parse, name, group);
  const sp = parse.span(`node:${name}`);
  const from = parse.parentOf(name) ?? null;
  if (!sp || from === (group ?? null)) return [];
  const nl = lineBreak(text);
  let end = lineEnd(text, sp.from);
  while (end > sp.from && isSpace(text[end - 1])) end--;
  const statement = text.slice(sp.from, end);
  const edits: TextEdit[] = [removeLines(text, lineStart(text, sp.from), nextLine(text, sp.from))];
  if (group) {
    const spot = groupSpot(text, parse, group);
    if (!spot) return [];
    edits.push(insertLine(text, spot.pos, spot.indent + statement, nl));
  } else {
    edits.push(insertLine(text, topLevelSpot(text, parse, name), statement, nl));
  }
  // The group it leaves keeps its braces even when empty: it stays drawn where it was (board DiagramGroups; diag-910
  // fix round 1, I5).
  return normalize(text, edits);
}

/**
 * Sets an attribute of a node or group (`id`, `icon`, `label`, `color`, `table`, or `kind` for the kind word); null
 * removes it, and the brackets go with the last item. A new key goes in its place in the attribute order (step 11).
 */
export function setAttr(text: string, parse: FlowParse, name: string, key: "kind" | FlowAttrKey, value: string | null): TextEdit[] {
  // Only the grammar's keys: anything else would write an attribute the parser refuses.
  if (key !== "kind" && !(ATTR_KEYS as readonly string[]).includes(key)) return [];
  if (key === "color" && value !== null && !isColourValue(value)) return [];
  const sp = parse.span(`node:${name}`) ?? parse.span(`group:${name}`);
  if (!sp?.name) return [];
  const item = (v: string) => (key === "kind" ? v : `${key}: ${attrValue(key, v)}`);
  const attrs = sp.attrs;
  if (!attrs) return value === null ? [] : [{ from: sp.name.to, to: sp.name.to, insert: ` [${item(value)}]` }];
  const closed = text[attrs.to - 1] === "]";
  const innerTo = closed ? attrs.to - 1 : attrs.to;
  const inner = text.slice(attrs.from + 1, innerTo).trim();
  const remove = (r: FlowRange): TextEdit => {
    if (inner === text.slice(r.from, r.to)) {
      let from = attrs.from;
      while (from > sp.name!.to && isBlankChar(text[from - 1])) from--;
      return { from, to: attrs.to, insert: "" };
    }
    return removeItem(text, r);
  };
  const existing = key === "kind" ? sp.kind : sp.values && Object.prototype.hasOwnProperty.call(sp.values, key) ? sp.values[key] : undefined;
  if (existing) {
    if (value === null) return [remove(key === "kind" ? existing : { from: keyStart(text, existing.from), to: existing.to })];
    return [{ from: existing.from, to: existing.to, insert: key === "kind" ? value : attrValue(key, value) }];
  }
  if (value === null) return [];
  if (inner === "") return [{ from: attrs.from + 1, to: innerTo, insert: item(value) }];
  if (key === "kind") return [{ from: attrs.from + 1, to: attrs.from + 1, insert: `${value}, ` }];
  // Before the first key written that comes after it in the order (id, icon, label, color, table).
  const rank = ATTR_KEYS.indexOf(key);
  let next: FlowRange | null = null;
  for (const [k, r] of Object.entries(sp.values ?? {})) {
    const at = keyStart(text, r.from);
    if (ATTR_KEYS.indexOf(k as FlowAttrKey) > rank && (!next || at < next.from)) next = { from: at, to: r.to };
  }
  if (next) return [{ from: next.from, to: next.from, insert: `${item(value)}, ` }];
  let at = innerTo;
  while (at > attrs.from + 1 && isSpace(text[at - 1])) at--;
  return [{ from: at, to: at, insert: `, ${item(value)}` }];
}

/** The start of `key: value` from its value's start. */
function keyStart(s: string, valueFrom: number): number {
  let j = valueFrom;
  while (j > 0 && isBlankChar(s[j - 1])) j--;
  if (s[j - 1] === ":") j--;
  while (j > 0 && isBlankChar(s[j - 1])) j--;
  while (j > 0 && !isSpace(s[j - 1]) && s[j - 1] !== "," && s[j - 1] !== "[") j--;
  return j;
}

/** Deletes one bracket item and the comma that joins it to its neighbour. */
function removeItem(s: string, item: FlowRange): TextEdit {
  let after = item.to;
  while (after < s.length && isBlankChar(s[after])) after++;
  if (s[after] === ",") {
    let to = after + 1;
    while (to < s.length && isBlankChar(s[to])) to++;
    return { from: item.from, to, insert: "" };
  }
  let before = item.from;
  while (before > 0 && isBlankChar(s[before - 1])) before--;
  if (s[before - 1] === ",") return { from: before - 1, to: item.to, insert: "" };
  return { from: item.from, to: item.to, insert: "" };
}

/** Deletes link `index`: its statement line, or from a chain (`A > B > C`) only that link, which keeps the others. Comments stay. */
export function deleteLink(text: string, parse: FlowParse, index: number): TextEdit[] {
  if (!Number.isInteger(index) || !parse.span(`link:${index}`)?.line) return [];
  const edits: TextEdit[] = [];
  removeLinks(text, parse, (_, i) => i === index, edits, lineBreak(text));
  // A sequence's loop left with no message goes too (board DiagramSequence).
  for (const f of frameSpots(text, parse)) {
    if (f.from !== index || f.to !== index) continue;
    edits.push(removeLines(text, f.openLine, nextLine(text, f.openLine)), removeLines(text, f.closeLine, nextLine(text, f.closeLine)));
  }
  return normalize(text, edits);
}

/** Sets or removes (null or "") the label of link `index`; a label inside a chain splits the chain there. */
export function setLinkLabel(text: string, parse: FlowParse, index: number, label: string | null): TextEdit[] {
  const sp = Number.isInteger(index) && index >= 0 ? parse.span(`link:${index}`) : null;
  if (!sp?.toName || !sp.line) return [];
  const fan = fanOf(parse, index);
  if (fan) {
    const next = label === null || label === "" ? null : label;
    if ((parse.links[index].label ?? null) === next) return [];
    return splitFanLink(text, parse, index, fan, linkStatement(text, parse, index, { label: next === null ? null : flowLabel(next) }));
  }
  if (label === null || label === "") return sp.label ? [{ from: sp.toName.to, to: sp.label.to, insert: "" }] : [];
  if (sp.label) return [{ from: sp.label.from, to: sp.label.to, insert: flowLabel(label) }];
  const next = parse.span(`link:${index + 1}`);
  const insert = `: ${flowLabel(label)}`;
  if (!next?.line || next.line.from !== sp.line.from) return [{ from: sp.toName.to, to: sp.toName.to, insert }];
  const again = text.slice(sp.toName.from, sp.toName.to);
  return [{ from: sp.toName.to, to: sp.toName.to, insert: insert + lineBreak(text) + indentAt(text, sp.line.from) + again }];
}

/**
 * A line as the canvas names it (fix round 1, I1): its two ends, its label, and which of the lines with those three
 * it is (0 for the first), so an op made on a drawing that has since changed finds the line meant or refuses.
 */
export interface LinkRef {
  from: string;
  to: string;
  label: string | null;
  nth: number;
  /** An ER relationship's columns: two lines between the same tables differ by them. */
  fromColumn?: string;
  toColumn?: string;
}

/** True when link `l` has the ends, columns and label of `r`. */
function sameLine(l: FlowLink, r: { from: string; to: string; label?: string | null; fromColumn?: string; toColumn?: string }): boolean {
  return l.from === r.from && l.to === r.to && (l.label ?? null) === (r.label ?? null) && l.fromColumn === r.fromColumn && l.toColumn === r.toColumn;
}

/** The ref of link `index` among `links` (a mind map branch has none). */
export function linkRefOf(links: readonly FlowLink[], index: number): LinkRef | null {
  const l = links[index];
  if (!l || l.tree) return null;
  const label = l.label ?? null;
  let nth = 0;
  for (let i = 0; i < index; i++) {
    const o = links[i];
    if (!o.tree && sameLine(o, l)) nth++;
  }
  const ref: LinkRef = { from: l.from, to: l.to, label, nth };
  if (l.fromColumn !== undefined) ref.fromColumn = l.fromColumn;
  if (l.toColumn !== undefined) ref.toColumn = l.toColumn;
  return ref;
}

/** The index of the line `ref` names in this parse, or null. */
export function findLink(parse: FlowParse, ref: LinkRef): number | null {
  let seen = 0;
  for (let i = 0; i < parse.links.length; i++) {
    const l = parse.links[i];
    if (l.tree || !sameLine(l, ref)) continue;
    if (seen++ === ref.nth) return i;
  }
  return null;
}

export const LINK_NOTES = {
  gone: "That line is no longer in the text, so nothing was changed.",
  broken: "Fix the text first: the drawing is the last one without errors.",
  marker: "The start only begins a line and the end only ends one.",
  reverseMarker: "A line from the start or to the end cannot be reversed: the start only begins a line and the end only ends one.",
  unknown: (node: string) => `${node} is not in the text.`,
  arrow: (arrow: string) => `${arrow} is not a line this kind of diagram draws.`,
};

/** Runs a line op on the line `ref` names, or says why not (a text with errors, a line no longer there). */
function onLink(parse: FlowParse, ref: LinkRef, run: (index: number) => FlowEditResult): FlowEditResult {
  if (!parse.doc) return { edits: [], note: LINK_NOTES.broken };
  const index = findLink(parse, ref);
  if (index === null) return { edits: [], note: LINK_NOTES.gone };
  return run(index);
}

/** The other links written on link `index`'s line (a chain `A > B > C`), first to last, `index` among them. */
function chainOf(parse: FlowParse, index: number): number[] {
  const line = parse.span(`link:${index}`)?.line;
  if (!line) return [];
  let a = index;
  while (a > 0 && parse.span(`link:${a - 1}`)?.line?.from === line.from) a--;
  let b = index;
  while (b + 1 < parse.links.length && parse.span(`link:${b + 1}`)?.line?.from === line.from) b++;
  return Array.from({ length: b - a + 1 }, (_, k) => a + k);
}

/**
 * Rewrites link `index` as `from arrow to` (the names as written in the text). On a line of its own only the
 * parts that change are replaced; in a chain the chain is split into one statement per link, in order, so the
 * others keep what they say.
 */
function rewriteLink(text: string, parse: FlowParse, index: number, next: { from: string; arrow: FlowArrow; to: string }): TextEdit[] {
  const sp = parse.span(`link:${index}`);
  if (!sp?.fromName || !sp.toName || !sp.arrow || !sp.line) return [];
  const fan = fanOf(parse, index);
  if (fan) return splitFanLink(text, parse, index, fan, linkStatement(text, parse, index, next));
  const chain = chainOf(parse, index);
  if (chain.length <= 1) {
    const edits: TextEdit[] = [];
    const put = (r: FlowRange, v: string) => {
      if (text.slice(r.from, r.to) !== v) edits.push({ from: r.from, to: r.to, insert: v });
    };
    put(sp.fromName, next.from);
    put(sp.arrow, next.arrow);
    put(sp.toName, next.to);
    return normalize(text, edits);
  }
  const nl = lineBreak(text);
  const indent = indentAt(text, sp.line.from);
  const statements = chain.map((k) => {
    const ks = parse.span(`link:${k}`)!;
    const slice = (r: FlowRange | undefined) => (r ? text.slice(r.from, r.to) : "");
    const [from, arrow, to] = k === index ? [next.from, next.arrow, next.to] : [slice(ks.fromName), slice(ks.arrow), slice(ks.toName)];
    const label = ks.label ? `: ${text.slice(ks.label.from, ks.label.to)}` : "";
    const attrs = ks.attrs ? ` ${text.slice(ks.attrs.from, ks.attrs.to)}` : "";
    return `${from} ${arrow} ${to}${label}${attrs}`;
  });
  return [{ from: sp.line.from, to: sp.line.to, insert: statements.join(nl + indent) }];
}

/** The text of link `index`'s two names as written, or null when the link has no line (a mind map branch). */
function linkNames(text: string, parse: FlowParse, index: number): { from: string; to: string; arrow: FlowArrow } | null {
  if (!Number.isInteger(index) || index < 0 || index >= parse.links.length) return null;
  const sp = parse.span(`link:${index}`);
  if (!sp?.fromName || !sp.toName || !sp.arrow) return null;
  return { from: text.slice(sp.fromName.from, sp.fromName.to), to: text.slice(sp.toName.from, sp.toName.to), arrow: parse.links[index].arrow };
}

/** Sets link `index`'s arrow to one its kind draws (`ARROWS`); the names and label stay as written. */
export function setLinkArrow(text: string, parse: FlowParse, index: number, arrow: FlowArrow): TextEdit[] {
  const at = linkNames(text, parse, index);
  if (!at || at.arrow === arrow || !parse.kind || !ARROWS[parse.kind].includes(arrow)) return [];
  if (fanOf(parse, index)) return rewriteLink(text, parse, index, { from: at.from, arrow, to: at.to });
  const sp = parse.span(`link:${index}`)!;
  return [{ from: sp.arrow!.from, to: sp.arrow!.to, insert: arrow }];
}

/**
 * Step 11: sets (or clears, null) link `index`'s colour, written `[color: name]` after its label. A link inside a
 * chain is first split onto its own line, so only it takes the colour.
 */
export function setLinkColor(text: string, parse: FlowParse, index: number, color: string | null): TextEdit[] {
  const sp = Number.isInteger(index) && index >= 0 ? parse.span(`link:${index}`) : null;
  if (!sp?.toName || !sp.line || !parse.kind || !LINE_COLOUR_DIAGRAMS.has(parse.kind)) return [];
  if (color !== null && !isColourValue(color)) return [];
  const link = parse.links[index];
  if (link.tree || (link.color ?? null) === color) return [];
  const written = color === null ? "" : `[color: ${attrValue("color", color)}]`;
  const fan = fanOf(parse, index);
  if (fan) return splitFanLink(text, parse, index, fan, linkStatement(text, parse, index, { attrs: color === null ? null : written }));
  if (sp.attrs) {
    if (color === null) {
      let from = sp.attrs.from;
      while (from > sp.line.from && isBlankChar(text[from - 1])) from--;
      return [{ from, to: sp.attrs.to, insert: "" }];
    }
    return [{ from: sp.attrs.from, to: sp.attrs.to, insert: written }];
  }
  if (color === null) return [];
  const chain = chainOf(parse, index);
  // The last link of a chain takes it in place, as it takes a label; any other is split off first.
  if (chain.length > 1 && chain[chain.length - 1] !== index) {
    const names = linkNames(text, parse, index);
    if (!names) return [];
    const split = rewriteLink(text, parse, index, { from: names.from, arrow: names.arrow, to: names.to });
    if (split.length !== 1) return [];
    // The split writes one statement per link in order; the coloured one gains its brackets.
    const statements = split[0].insert.split(lineBreak(text) + indentAt(text, sp.line.from));
    const k = chain.indexOf(index);
    statements[k] += ` ${written}`;
    return [{ ...split[0], insert: statements.join(lineBreak(text) + indentAt(text, sp.line.from)) }];
  }
  const end = sp.label ? sp.label.to : sp.toName.to;
  return [{ from: end, to: end, insert: ` ${written}` }];
}

/** An ER relationship read from its other end: `>` becomes `<`, so each table keeps its end. */
const REVERSED: Partial<Record<FlowArrow, FlowArrow>> = { ">": "<", "<": ">" };

/** Swaps link `index`'s two ends (draw.io's Reverse); an ER relationship's cardinality turns with them. */
export function reverseLink(text: string, parse: FlowParse, index: number): TextEdit[] {
  const at = linkNames(text, parse, index);
  if (!at) return [];
  const arrow = parse.kind === "er" ? (REVERSED[at.arrow] ?? at.arrow) : at.arrow;
  return rewriteLink(text, parse, index, { from: at.to, arrow, to: at.from });
}

/**
 * Moves one end of link `index` onto `node` (a drag of the line's end, as draw.io reattaches). A state diagram's
 * markers are written `[*]`, the start only as a `from` and the end only as a `to`.
 */
export function setLinkEnd(text: string, parse: FlowParse, index: number, end: "from" | "to", node: string, column?: string): TextEdit[] {
  const at = linkNames(text, parse, index);
  if (!at) return [];
  const link = parse.links[index];
  if ((end === "from" ? link.from : link.to) === node && (end === "from" ? link.fromColumn : link.toColumn) === column) return [];
  let written: string;
  if (node === STATE_START || node === STATE_END) {
    if (parse.kind !== "state" || (node === STATE_START) !== (end === "from")) return [];
    written = "[*]";
  } else {
    if (!parse.defined.has(node)) return [];
    if (column !== undefined && (parse.kind !== "er" || !columnNames(text, parse, node).includes(column) || !columnEndReads(parse, node, column))) return [];
    written = linkEndText(node, column);
  }
  return rewriteLink(text, parse, index, end === "from" ? { ...at, from: written } : { ...at, to: written });
}

/**
 * Fix round 2, N1: a line written inside a composite's braces whose end goes to the diagram's start or end. Its line is
 * rewritten with `[*]` and moved after the last line outside every composite (or to the end), so the `[*]` reads as the
 * diagram's. Null when the line is not inside any composite (the usual rewrite applies).
 */
function moveOutForMarker(text: string, parse: FlowParse, index: number, end: "from" | "to", node: string): FlowEditResult | null {
  const sp = parse.span(`link:${index}`);
  const line = sp?.line;
  if (!sp?.fromName || !sp.toName || !sp.arrow || !line) return null;
  let inside: string | null = null;
  let from = -1;
  for (const g of parse.defined.keys()) {
    const b = parse.span(`group:${g}`);
    if (b && b.from <= line.from && line.from < b.to && b.from > from) {
      inside = g;
      from = b.from;
    }
  }
  if (inside === null) return null;
  const link = parse.links[index];
  const other = end === "from" ? link.to : link.from;
  if (isStateMarker(other) && other !== STATE_START && other !== STATE_END) {
    const own = isStateStart(other) ? "start" : "end";
    const target = node === STATE_START ? "start" : "end";
    return { edits: [], note: `This line ${own === "start" ? "starts" : "ends"} at ${inside}'s own ${own}, so it stays inside ${inside}. Draw a new line to ${target === "start" ? "begin" : "end"} at the diagram's ${target}.` };
  }
  if (chainOf(parse, index).length > 1) return { edits: [], note: `This line is part of a chain inside ${inside}. Split the chain in the text first.` };
  const otherText = text.slice(end === "from" ? sp.toName.from : sp.fromName.from, end === "from" ? sp.toName.to : sp.fromName.to);
  const arrow = text.slice(sp.arrow.from, sp.arrow.to);
  const label = link.label ? `: ${flowLabel(link.label)}` : "";
  const written = end === "from" ? `[*] ${arrow} ${otherText}${label}` : `${otherText} ${arrow} [*]${label}`;
  const nl = lineBreak(text);
  const last = lastLinkIn(parse, null);
  const edits: TextEdit[] = [removeStatement(text, line.from, line.to)];
  edits.push(last ? insertLine(text, nextLine(text, last.from), indentAt(text, last.from) + written, nl) : insertLine(text, text.length, written, nl));
  return { edits: normalize(text, edits) };
}

// ----- ER columns

/** Why an ER edit was refused. */
export const ER_NOTES = {
  oldForm: "Rewrite this diagram as table blocks first: its first problem has the fix.",
  readsAsColumn: (line: string, table: string) => `${line} reads as a column of table ${table}. Pick another name.`,
  caseTaken: (name: string) => `${name} already has that name, in another case.`,
  needsQuotes: (name: string) => `${name} needs quotes, and a table with column relationships cannot have them. Use letters, digits, _ and dots.`,
  quotedEnd: (table: string) => `${table} needs quotes, so a line cannot end on one of its columns. Rename it with letters, digits, _ and dots first.`,
  renameMoves: (name: string, end: string) => `Renamed ${name}, ${end} would point at another table, so nothing was renamed.`,
  columnMoves: (end: string) => `${end} would point at another table, so the column keeps its name.`,
  endMoves: (end: string) => `${end} would point at another table, so the line was not changed.`,
  notTable: (name: string) => `${name} is not a table.`,
  unclosed: (table: string) => `${table} has no closing }.`,
  columnTaken: (table: string, name: string) => `${table} already has a column ${name}.`,
  columnName: "A column name is letters, digits and _, not starting with a digit.",
  typeLine: "A column type is written on one line.",
  typeReads: (type: string) => `${type} does not read back as one type. Check its parentheses and quotes.`,
  staleColumn: "That column is no longer in the text, so nothing was changed.",
  flagWords: (column: string) => `Fix the flag words on ${column} first: pk, not null or unique.`,
  unknownFlag: (flag: string) => `${flag} is not a column flag: pk, not null or unique.`,
  oldIncoming: "The diagram coming in is written in the old form. Rewrite it as table blocks first, so nothing was inserted.",
};

/** True for an ER frame still in the old form: its edits wait for "Rewrite as table blocks", so no old line is touched. */
export function oldErFrame(parse: FlowParse): boolean {
  return parse.oldEr;
}

const refused = (note: string): FlowEditResult => ({ edits: [], note });

/** Why `table` takes no column edits, or null when it does. */
function columnOwnerNote(parse: FlowParse, table: string): string | null {
  if (oldErFrame(parse)) return ER_NOTES.oldForm;
  if (!parse.span(`node:${table}`)) return LINK_NOTES.unknown(table);
  const kind = parse.kindOf(table);
  return parse.kind !== "er" || parse.definedTwice.has(table) || (kind !== "entity" && kind !== "weak") ? ER_NOTES.notTable(table) : null;
}

const textOf = (text: string, r: FlowRange) => text.slice(r.from, r.to);

/** A column's name as written. */
function columnName(text: string, row: RowSpan): string {
  return row.column ? textOf(text, row.column) : "";
}

/** The names of a table's columns, as written. */
function columnNames(text: string, parse: FlowParse, table: string): string[] {
  return parse.rowsOf(table).map((r) => columnName(text, r));
}

/**
 * True when the end `table.column` reads back as that table's column: written bare, no node of that whole name, and
 * `table` the longest name before a dot that is a table (`sales.orders.id` is the column id of `sales.orders`). With
 * `rename`, as the names will be once `old` is called `next`.
 */
function columnEndReads(parse: FlowParse, table: string, column: string, rename?: { old: string; next: string }): boolean {
  const written = `${table}.${column}`;
  if (needsQuotes(table) || needsQuotes(written)) return false;
  const has = (n: string) => (rename !== undefined && n === rename.next) || (n !== rename?.old && parse.defined.has(n));
  if (has(written)) return false;
  // The reader tries the first MAX_PREFIX_DOTS dots only, longest prefix first.
  const dots: number[] = [];
  for (let d = written.indexOf(".", 1); d > 0 && dots.length < MAX_PREFIX_DOTS; d = written.indexOf(".", d + 1)) dots.push(d);
  for (let k = dots.length - 1; k >= 0; k--) {
    const t = written.slice(0, dots[k]);
    const kind = has(t) ? parse.kindOf(rename !== undefined && t === rename.next ? rename.old : t) : undefined;
    if (kind === "entity" || kind === "weak") return t === table;
  }
  return false;
}

/** A shape an edit writes, for `bareColumnClash`: its name, whether it is a table, and whether its line is bare. */
export type ErShape = { name: string; table: boolean; bare: boolean };

/** The bare dotted lines (`sales.orders`, no brackets, no block) and the tables of an ER frame. */
function erLines(text: string, parse: FlowParse, rename?: { old: string; next: string }, added: readonly ErShape[] = []): { bare: string[]; tables: Set<string> } {
  const bare: string[] = [];
  const tables = new Set<string>();
  for (const name of parse.defined.keys()) {
    const sp = parse.span(`node:${name}`);
    if (!sp?.name) continue;
    const now = rename && name === rename.old ? rename.next : name;
    const kind = parse.kindOf(name);
    if (kind === "entity" || kind === "weak") tables.add(now);
    const quoted = rename && name === rename.old ? needsQuotes(now) : text.charCodeAt(sp.name.from) === 34;
    if (!quoted && !sp.attrs && !parse.span(`table:${name}`) && now.includes(".")) bare.push(now);
  }
  for (const a of added) {
    if (a.table) tables.add(a.name);
    if (a.bare && !needsQuotes(a.name) && a.name.includes(".")) bare.push(a.name);
  }
  return { bare, tables };
}

/**
 * The first bare `T.x` line that would read as a column of table `T` once `old` is renamed `next` or `added` is
 * written, and that does not already read so; null when none would.
 */
export function bareColumnClash(text: string, parse: FlowParse, rename?: { old: string; next: string }, added: readonly ErShape[] = []): string | null {
  if (parse.kind !== "er") return null;
  const now = erLines(text, parse);
  const before = new Set<string>();
  for (const b of now.bare) {
    const t = longestPrefix(b, now.tables);
    if (t !== null) before.add(`${b}\n${t}`);
  }
  const after = erLines(text, parse, rename, added);
  for (const b of after.bare) {
    const t = longestPrefix(b, after.tables);
    if (t !== null && !before.has(`${b}\n${t}`)) return ER_NOTES.readsAsColumn(b, t);
  }
  return null;
}

/** Why renaming ER table or group `old` to `next` is refused, or null. */
export function erRenameNote(text: string, parse: FlowParse, old: string, next: string): string | null {
  if (parse.kind !== "er" || old === next) return null;
  if (oldErFrame(parse)) return ER_NOTES.oldForm;
  // SQL reads unquoted names in any case.
  const lower = next.toLowerCase();
  for (const name of parse.defined.keys()) if (name !== old && name.toLowerCase() === lower) return ER_NOTES.caseTaken(name);
  const clash = bareColumnClash(text, parse, { old, next });
  if (clash) return clash;
  // Every column end must still read as its table's column under the new name.
  const rename = { old, next };
  for (const l of parse.links) {
    for (const [table, column] of [
      [l.from, l.fromColumn],
      [l.to, l.toColumn],
    ] as const) {
      if (column === undefined) continue;
      const now = table === old ? next : table;
      if (table === old && needsQuotes(next)) return ER_NOTES.needsQuotes(next);
      if (!columnEndReads(parse, now, column, rename)) return ER_NOTES.renameMoves(next, `${now}.${column}`);
    }
  }
  return null;
}

/** Why a new ER relationship is refused, or null; null for every other kind's line with no columns. */
function addLinkNote(text: string, parse: FlowParse, from: string, to: string, arrow: FlowArrow, fromColumn?: string, toColumn?: string): string | null {
  if (fromColumn === undefined && toColumn === undefined && parse.kind !== "er") return null;
  if (parse.kind !== "er") return LINK_NOTES.unknown(`${from}.${fromColumn ?? toColumn}`);
  if (!ARROWS.er.includes(arrow)) return LINK_NOTES.arrow(arrow);
  for (const [table, column] of [
    [from, fromColumn],
    [to, toColumn],
  ] as const) {
    if (column === undefined) continue;
    if (!columnNames(text, parse, table).includes(column)) return LINK_NOTES.unknown(`${table}.${column}`);
    // `"crm:people".id` does not read: a quoted name takes no `.column`.
    if (needsQuotes(table)) return ER_NOTES.quotedEnd(table);
    if (!columnEndReads(parse, table, column)) return ER_NOTES.endMoves(`${table}.${column}`);
  }
  return null;
}

/** The flags written after a column's type; null when a word there is no flag (a problem the text has to fix). */
function columnFlagsOf(text: string, row: RowSpan): Set<ColumnFlag> | null {
  const out = new Set<ColumnFlag>();
  if (!row.flags) return out;
  const words = textOf(text, row.flags).toLowerCase().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "pk" || w === "unique") out.add(w);
    else if (w === "not" && words[i + 1] === "null") {
      out.add("not null");
      i++;
    } else return null;
  }
  return out;
}

/** The column at `index` when the text still has `column` there, else why not. */
function columnAt(text: string, parse: FlowParse, table: string, index: number, column: string): RowSpan | string {
  const why = columnOwnerNote(parse, table);
  if (why) return why;
  const row = parse.rowsOf(table)[index];
  return row?.column && columnName(text, row) === column ? row : ER_NOTES.staleColumn;
}

/** The other column of the table that already has this name, in any case; null when none has. */
function columnTaken(text: string, rows: readonly RowSpan[], name: string, except = -1): string | null {
  const lower = name.toLowerCase();
  return rows.some((r, i) => i !== except && columnName(text, r).toLowerCase() === lower) ? name : null;
}

/** A column type as a column line writes it ("" for none), or why it cannot be written. */
function writtenType(type: string): { written: string } | { note: string } {
  if (type === "") return { written: "" };
  if (/[\r\n]/.test(type)) return { note: ER_NOTES.typeLine };
  const written = columnTypeText(type);
  const p = type === type.trim() ? parseFlow(`diagram er "t"\nt {\n  c ${written}\n}\n`) : null;
  const node = p?.doc?.nodes[0];
  return node?.rows?.[0] === `c ${type}` && !node.rowFlags ? { written } : { note: ER_NOTES.typeReads(type) };
}

/**
 * The column line `body` before the column at `at`, or after the last one (before the table's `}`). A table written
 * on one line (`a {}`) opens around it; a bare table line becomes a block.
 */
function insertColumn(text: string, parse: FlowParse, table: string, at: number, before: string | null, body: string): FlowEditResult {
  const rows = parse.rowsOf(table);
  // The place the canvas saw: before that column, or after the last one.
  if (before === null ? at < rows.length : !rows[at] || columnName(text, rows[at]) !== before) return refused(ER_NOTES.staleColumn);
  const nl = lineBreak(text);
  if (at >= 0 && at < rows.length) {
    const ref = rows[at].line.from;
    return { edits: [insertLine(text, lineStart(text, ref), indentAt(text, ref) + body, nl)] };
  }
  const node = parse.span(`node:${table}`)!;
  const own = indentAt(text, node.from);
  const block = parse.span(`table:${table}`);
  if (block) {
    // An unclosed table is a problem already: the column waits for its `}`.
    if (!block.open || !block.close) return refused(ER_NOTES.unclosed(table));
    const indent = rows.length ? indentAt(text, rows[rows.length - 1].line.from) : `${own}  `;
    if (lineStart(text, block.close.from) <= block.open.from) return { edits: [{ from: block.open.to, to: block.close.from, insert: `${nl}${indent}${body}${nl}${own}` }] };
    return { edits: [insertLine(text, lineStart(text, block.close.from), indent + body, nl)] };
  }
  // A comment after the table's line stays on it, after the new `{`.
  const edits = [{ from: node.to, to: node.to, insert: " {" }, insertLine(text, nextLine(text, node.to), `${own}  ${body}${nl}${own}}`, nl)];
  return { edits: normalize(text, edits) };
}

/** A new column line `name type flags` before the column at `at`, or after the last one. */
export function addColumn(
  text: string,
  parse: FlowParse,
  table: string,
  at: number,
  before: string | null,
  name: string,
  type: string,
  flags: readonly ColumnFlag[] = [],
): FlowEditResult {
  const why = columnOwnerNote(parse, table);
  if (why) return refused(why);
  if (!isColumnName(name)) return refused(ER_NOTES.columnName);
  if (columnTaken(text, parse.rowsOf(table), name)) return refused(ER_NOTES.columnTaken(table, name));
  const t = writtenType(type);
  if ("note" in t) return refused(t.note);
  return insertColumn(text, parse, table, at, before, `${name}${t.written ? ` ${t.written}` : ""}${columnFlagsText(flags)}`);
}

/** Renames or retypes one column in place; its flags, its comment and the spacing between them stay. */
export function setColumn(text: string, parse: FlowParse, table: string, index: number, column: string, name?: string, type?: string): FlowEditResult {
  const row = columnAt(text, parse, table, index, column);
  if (typeof row === "string") return refused(row);
  if (!row.column) return refused(ER_NOTES.staleColumn);
  const edits: TextEdit[] = [];
  if (name !== undefined && name !== column) {
    if (!isColumnName(name)) return refused(ER_NOTES.columnName);
    if (columnTaken(text, parse.rowsOf(table), name, index)) return refused(ER_NOTES.columnTaken(table, name));
    edits.push({ from: row.column.from, to: row.column.to, insert: name });
    // The relationships that name the column follow it, in the same edit list. In a chain or a fan one end
    // belongs to several links: `seen` writes it once.
    const seen = new Set<number>();
    const end = (r: FlowRange | undefined) => {
      if (!r || seen.has(r.from)) return;
      seen.add(r.from);
      edits.push({ from: r.to - column.length, to: r.to, insert: name });
    };
    parse.links.forEach((l, i) => {
      const sp = parse.span(`link:${i}`);
      if (l.from === table && l.fromColumn === column) end(sp?.fromName);
      if (l.to === table && l.toColumn === column) end(sp?.toName);
    });
    if (seen.size > 0 && !columnEndReads(parse, table, name)) return refused(ER_NOTES.columnMoves(`${table}.${name}`));
  }
  if (type !== undefined) {
    const t = writtenType(type);
    if ("note" in t) return refused(t.note);
    const cur = row.type ? textOf(text, row.type) : "";
    if (t.written !== cur) {
      if (!row.type) edits.push({ from: row.column.to, to: row.column.to, insert: ` ${t.written}` });
      else if (!t.written) edits.push({ from: row.column.to, to: row.type.to, insert: "" });
      else edits.push({ from: row.type.from, to: row.type.to, insert: t.written });
    }
  }
  return { edits: normalize(text, edits) };
}

/** Turns one flag on or off and writes the flag words as `pk not null unique`; the type and a comment stay. */
export function setColumnFlag(text: string, parse: FlowParse, table: string, index: number, column: string, flag: ColumnFlag, on: boolean): FlowEditResult {
  const row = columnAt(text, parse, table, index, column);
  if (typeof row === "string") return refused(row);
  const before = columnFlagsOf(text, row);
  if (!before) return refused(ER_NOTES.flagWords(column));
  if (!COLUMN_FLAGS.includes(flag)) return refused(ER_NOTES.unknownFlag(flag));
  if (!row.column || before.has(flag) === on) return { edits: [] };
  const after = new Set(before);
  if (on) after.add(flag);
  else after.delete(flag);
  const words = columnFlagsText(after);
  const start = row.type?.to ?? row.column.to;
  if (!row.flags) return { edits: [{ from: start, to: start, insert: words }] };
  return { edits: words ? [{ from: row.flags.from, to: row.flags.to, insert: words.slice(1) }] : [{ from: start, to: row.flags.to, insert: "" }] };
}

/** A copy of the column below it, named `name_copy` (then `name_copy2`, ...), not a key (draw.io's Ctrl+Enter). */
export function duplicateColumn(text: string, parse: FlowParse, table: string, index: number, column: string): FlowEditResult {
  const row = columnAt(text, parse, table, index, column);
  if (typeof row === "string") return refused(row);
  const flags = columnFlagsOf(text, row);
  if (!flags) return refused(ER_NOTES.flagWords(column));
  const rows = parse.rowsOf(table);
  let name = `${column}_copy`;
  for (let n = 2; columnTaken(text, rows, name); n++) name = `${column}_copy${n}`;
  if (flags.delete("pk")) flags.add("not null");
  const type = row.type ? textOf(text, row.type) : "";
  const next = rows[index + 1];
  return insertColumn(text, parse, table, index + 1, next ? columnName(text, next) : null, `${name}${type ? ` ${type}` : ""}${columnFlagsText(flags)}`);
}

/** Deletes one column's line, with a comment on that line, and the relationships that use the column. */
export function deleteColumn(text: string, parse: FlowParse, table: string, index: number, column: string): FlowEditResult {
  const row = columnAt(text, parse, table, index, column);
  if (typeof row === "string") return refused(row);
  // A comment on the column's own line is about the column: it goes with it.
  const edits = [removeLines(text, lineStart(text, row.line.from), nextLine(text, row.line.from))];
  const uses = (l: FlowLink) => (l.from === table && l.fromColumn === column) || (l.to === table && l.toColumn === column);
  if (parse.links.some(uses)) removeLinks(text, parse, uses, edits, lineBreak(text));
  return { edits: normalize(text, edits) };
}

// ----- class members (diagram step 3, CL1)

/** A class, interface or enum the canvas can write members for. */
function memberOwner(parse: FlowParse, owner: string): boolean {
  const n = parse.doc?.nodes.find((x) => x.name === owner) ?? null;
  return parse.kind === "class" && !!parse.span(`node:${owner}`) && !parse.definedTwice.has(owner) && (!n || n.kind === "class" || n.kind === "interface" || n.kind === "enum");
}

/** Where a member line's text is, after `Owner :`. */
function memberText(text: string, row: RowSpan): FlowRange {
  let from = text.indexOf(":", row.name?.to ?? row.line.from) + 1;
  while (from < row.line.to && isBlankChar(text[from])) from++;
  return { from: Math.min(from, row.line.to), to: row.line.to };
}

/** Each member of `owner` as the parser read it (a quoted one unquoted), or the raw text while the text has errors. */
function memberValues(text: string, parse: FlowParse, owner: string): string[] {
  const rows = parse.rowsOf(owner);
  const read = parse.doc?.nodes.find((n) => n.name === owner)?.rows;
  return rows.map((r, i) => read?.[i] ?? text.slice(memberText(text, r).from, r.line.to));
}

const sameMember = (a: string, b: string) => a.replace(/\s/g, "") === b.replace(/\s/g, "");

/** The member at `index` when the text still has `was` there. */
function memberAt(text: string, parse: FlowParse, owner: string, index: number, was: string): RowSpan | undefined {
  if (!memberOwner(parse, owner)) return undefined;
  const row = parse.rowsOf(owner)[index];
  return row && memberValues(text, parse, owner)[index] === was ? row : undefined;
}

/** True when another member of the class is the same, spaces aside (board: "+ qty: int is already a member"). */
function memberTaken(values: readonly string[], member: string, except = -1): boolean {
  return values.some((v, i) => i !== except && sameMember(v, member));
}

/** A new member line before the member at `at`, or after the last one (after the class's own line when it has none). */
export function addMember(text: string, parse: FlowParse, owner: string, at: number, member: string): TextEdit[] {
  const value = member.trim();
  if (!memberOwner(parse, owner) || !value || /[\r\n]/.test(value)) return [];
  const rows = parse.rowsOf(owner);
  if (memberTaken(memberValues(text, parse, owner), value)) return [];
  const node = parse.span(`node:${owner}`)!;
  const ref = at >= 0 && at < rows.length ? rows[at].line.from : rows.length > 0 ? rows[rows.length - 1].line.from : node.from;
  const pos = at >= 0 && at < rows.length ? lineStart(text, ref) : nextLine(text, ref);
  return [insertLine(text, pos, `${indentAt(text, ref)}${flowName(owner)} : ${flowLabel(value)}`, lineBreak(text))];
}

/** Rewrites one member's text in place; the owner's part of the line stays as written. */
export function setMember(text: string, parse: FlowParse, owner: string, index: number, was: string, member: string): TextEdit[] {
  const row = memberAt(text, parse, owner, index, was);
  const value = member.trim();
  if (!row || !value || /[\r\n]/.test(value) || value === was || memberTaken(memberValues(text, parse, owner), value, index)) return [];
  const r = memberText(text, row);
  return [{ from: r.from, to: r.to, insert: flowLabel(value) }];
}

/** A copy of the member below it, its first word made `word_copy` (then `word_copy2`), as draw.io's Ctrl+Enter. */
export function duplicateMember(text: string, parse: FlowParse, owner: string, index: number, was: string): TextEdit[] {
  const row = memberAt(text, parse, owner, index, was);
  if (!row) return [];
  const values = memberValues(text, parse, owner);
  let copy = was.replace(/(\w+)/, "$1_copy");
  for (let n = 2; memberTaken(values, copy); n++) copy = was.replace(/(\w+)/, `$1_copy${n}`);
  if (copy === was) return [];
  return addMember(text, parse, owner, index + 1, copy);
}

/** Deletes one member's line, with a comment on that line. */
export function deleteMember(text: string, parse: FlowParse, owner: string, index: number, was: string): TextEdit[] {
  const row = memberAt(text, parse, owner, index, was);
  if (!row) return [];
  return [removeLines(text, lineStart(text, row.line.from), nextLine(text, row.line.from))];
}

// ----- timeline dates (T1)

const isDate = (d: string) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d);
/** Dates of any precision compared as the earliest day they name (`2026-10` is 2026-10-01). */
const dayKey = (d: string) => (d.length === 4 ? `${d}-01-01` : d.length === 7 ? `${d}-01` : d);

/** An event's date, or a period's two, written before its `:`; an end before the start writes nothing. */
export function setDate(text: string, parse: FlowParse, name: string, date: string, until?: string): TextEdit[] {
  const node = parse.doc?.nodes.find((n) => n.name === name);
  const sp = parse.span(`node:${name}`);
  if (parse.kind !== "timeline" || !sp?.name || !node || (node.kind !== "event" && node.kind !== "period")) return [];
  if (!isDate(date) || (node.kind === "period") !== (until !== undefined)) return [];
  if (until !== undefined && (!isDate(until) || dayKey(until) < dayKey(date))) return [];
  const head = text.slice(sp.from, sp.name.from);
  let to = sp.from + head.lastIndexOf(":");
  if (to < sp.from) return [];
  while (to > sp.from && isBlankChar(text[to - 1])) to--;
  const insert = until === undefined ? date : `${date} to ${until}`;
  return normalize(text, [{ from: sp.from, to, insert }]);
}

// ----- ungroup (D1)

/** Takes a group apart: its two brace lines go, what it held moves out one level, a line to the group itself goes. */
export function ungroup(text: string, parse: FlowParse, name: string): TextEdit[] {
  const sp = parse.span(`group:${name}`);
  if (!sp?.open || !sp.close || parse.definedTwice.has(name)) return [];
  const nl = lineBreak(text);
  const edits: TextEdit[] = [];
  const openLine = lineStart(text, sp.from);
  const closeLine = lineStart(text, sp.close.from);
  edits.push({ from: openLine, to: nextLine(text, sp.open.from), insert: "" });
  edits.push({ from: closeLine, to: nextLine(text, sp.close.from), insert: "" });
  removeLinks(text, parse, (l) => l.from === name || l.to === name, edits, nl);
  const removed = (p: number) => edits.some((e) => e.insert === "" && e.from <= p && p < e.to);
  // One level out: the least indent inside, past the group's own, comes off every line inside.
  const own = indentAt(text, sp.from).length;
  const inside: number[] = [];
  for (let p = nextLine(text, sp.open.from); p < closeLine; p = nextLine(text, p)) if (!isBlankLine(text, p) && !removed(p)) inside.push(p);
  const extra = Math.min(...inside.map((p) => indentAt(text, p).length - own));
  if (Number.isFinite(extra) && extra > 0) for (const p of inside) edits.push({ from: p + own, to: p + own + extra, insert: "" });
  return normalize(text, edits);
}

// ----- step 9: a group's own block (F9)

/** The group and every group inside it. */
function groupsWithin(parse: FlowParse, name: string): Set<string> {
  const out = new Set([name]);
  for (const g of parse.defined.keys()) {
    if (!parse.span(`group:${g}`)) continue;
    for (let p = parse.parentOf(g); p; p = parse.parentOf(p)) {
      if (out.has(p)) {
        out.add(g);
        break;
      }
    }
  }
  return out;
}

/** The whole lines a group's block covers: from its first line to the line after its `}`. */
function blockLines(text: string, parse: FlowParse, name: string, key: "group" | "table" = "group"): { from: number; to: number } | null {
  const sp = parse.span(`${key}:${name}`);
  if (!sp?.open || !sp.close || parse.definedTwice.has(name)) return null;
  return { from: lineStart(text, sp.from), to: nextLine(text, sp.close.from) };
}

/** The whole lines of an ER table written as a block, from its name to the line after its `}`; null for a bare table. */
const tableBlock = (text: string, parse: FlowParse, name: string) => blockLines(text, parse, name, "table");

/**
 * Delete with contents (F9; Visio's Delete on a container): the group's block goes with every shape and group in it,
 * their own lines (a class's members) and every line to any of them or to the groups.
 */
export function deleteGroup(text: string, parse: FlowParse, name: string): TextEdit[] {
  const block = blockLines(text, parse, name);
  if (!block) return [];
  const nl = lineBreak(text);
  const groups = groupsWithin(parse, name);
  const gone = new Set<string>(groups);
  for (const n of parse.defined.keys()) {
    if (gone.has(n)) continue;
    for (let p = parse.parentOf(n); p; p = parse.parentOf(p)) {
      if (groups.has(p)) {
        gone.add(n);
        break;
      }
    }
  }
  const inside = (p: number) => p >= block.from && p < block.to;
  // Lines in the block that are not about what goes, and its comments, stay where the block was (fix round 1, M4).
  const keepLines = new Map<number, boolean>();
  parse.links.forEach((l, i) => {
    const at = parse.span(`link:${i}`)?.line?.from;
    if (at === undefined || !inside(at)) return;
    const ok = !gone.has(l.from) && !gone.has(l.to);
    keepLines.set(lineStart(text, at), (keepLines.get(lineStart(text, at)) ?? true) && ok);
  });
  // A chain that only partly touches what goes keeps its other links, as a shape's delete keeps them (fix round 2, N6).
  const partial = new Map<number, string>();
  const chainEdits: TextEdit[] = [];
  removeLinks(text, parse, (l) => gone.has(l.from) || gone.has(l.to), chainEdits, nl);
  for (const e of chainEdits) if (e.insert !== "" && inside(e.from)) partial.set(lineStart(text, e.from), e.insert);
  const indent = indentAt(text, block.from);
  const kept: string[] = [];
  for (let p = block.from; p < block.to; p = nextLine(text, p)) {
    const t = text.slice(p, lineEnd(text, p)).trim();
    if (t.startsWith("//") || keepLines.get(p) === true) kept.push(indent + t);
    else if (partial.has(p)) kept.push(indent + partial.get(p)!.trim());
  }
  const edits: TextEdit[] = [kept.length ? { from: block.from, to: block.to, insert: kept.join(nl) + nl } : removeLines(text, block.from, block.to)];
  for (const n of gone) for (const row of parse.rowsOf(n)) if (!inside(row.line.from)) edits.push(removeStatement(text, row.line.from, row.line.to));
  // Lines written inside the block go with it; the others are taken out, a chain keeping the links it still has.
  const outside: TextEdit[] = [];
  removeLinks(text, parse, (l, i) => (gone.has(l.from) || gone.has(l.to)) && !inside(parse.span(`link:${i}`)?.line?.from ?? -1), outside, nl);
  for (const e of outside) if (!inside(e.from)) edits.push(e);
  return normalize(text, edits);
}

/**
 * A group dragged into another, or out of every group (F9; draw.io containers, Miro frames): its block moves,
 * re-indented, before the target's `}` or after the last statement outside every group. Never into itself or a group
 * inside it.
 */
function moveGroupBlock(text: string, parse: FlowParse, name: string, group: string | null): TextEdit[] {
  const block = blockLines(text, parse, name) ?? tableBlock(text, parse, name);
  const from = parse.parentOf(name) ?? null;
  if (!block || from === (group ?? null)) return [];
  if (group !== null && (groupsWithin(parse, name).has(group) || !parse.span(`group:${group}`))) return [];
  const nl = lineBreak(text);
  const own = indentAt(text, block.from);
  let pos: number;
  let indent: string;
  if (group) {
    const spot = groupSpot(text, parse, group);
    if (!spot) return [];
    pos = spot.pos;
    indent = spot.indent;
  } else {
    // After the last statement outside every group: a shape (with its own lines) or another group's block.
    pos = topLevelSpot(text, parse, name);
    for (const g of parse.defined.keys()) {
      if (g === name || parse.parentOf(g) !== null) continue;
      const b = blockLines(text, parse, g);
      if (b && b.to > pos) pos = b.to;
    }
    indent = "";
  }
  // Each line of the block, its own indent swapped for the new one.
  const out: string[] = [];
  for (let p = block.from; p < block.to; p = nextLine(text, p)) {
    const line = text.slice(p, lineEnd(text, p));
    out.push(isBlankLine(text, p) ? "" : indent + (line.startsWith(own) ? line.slice(own.length) : line.trimStart()));
  }
  const edits: TextEdit[] = [{ from: block.from, to: block.to, insert: "" }, insertLine(text, pos, out.join(nl), nl)];
  // A last line with no line break: the block ends the text, so the line before it keeps its own.
  if (block.to === text.length && !text.endsWith("\n") && block.from > 0) edits[0] = removeLines(text, block.from, block.to);
  return normalize(text, edits);
}

// ----- step 6: a mind map child, a sequence's activation and loop, a timeline's section

/** A topic after `parent`'s whole branch, one level in from it. */
function addTopicUnder(text: string, parse: FlowParse, name: string, parent: string, attrs: Record<string, string> = {}): TextEdit[] {
  const nodes = parse.doc?.nodes ?? [];
  const at = nodes.findIndex((n) => n.name === parent);
  const sp = parse.span(`node:${parent}`);
  if (at < 0 || !sp) return [];
  const depth = nodes[at].depth ?? 0;
  let last = sp.from;
  // The parser's depth follows the indent, so the direct children are the shallowest of the branch.
  let child: string | null = null;
  let childDepth = Number.POSITIVE_INFINITY;
  for (let i = at + 1; i < nodes.length && nodes[i].kind !== "note" && (nodes[i].depth ?? 0) > depth; i++) {
    const q = parse.span(`node:${nodes[i].name}`);
    if (!q) continue;
    last = q.from;
    if ((nodes[i].depth ?? 0) < childDepth) {
      childDepth = nodes[i].depth ?? 0;
      child = indentAt(text, q.from);
    }
  }
  // The indent its siblings use; with none yet, one step of the file's own indent further in (fix round 1, M4).
  const own = indentAt(text, sp.from);
  const indent = child ?? `${own}${mindStep(text, parse)}`;
  return [insertLine(text, nextLine(text, last), `${indent}${topicText(name, attrs)}`, lineBreak(text))];
}

/** One level of a mind map's indent as the file writes it: the first topic's indent, else two spaces. */
export function mindStep(text: string, parse: FlowParse): string {
  for (const n of parse.doc?.nodes ?? []) {
    if (n.kind !== "topic") continue;
    const q = parse.span(`node:${n.name}`);
    const root = parse.doc?.nodes.find((x) => x.kind === "root");
    const r = root ? parse.span(`node:${root.name}`) : null;
    if (q) {
      const step = indentAt(text, q.from).slice(r ? indentAt(text, r.from).length : 0);
      if (step) return step;
    }
  }
  return "  ";
}

/** `activate Name` after the last message (Visio's activation bar from here on). */
export function addActivation(text: string, parse: FlowParse, name: string): TextEdit[] {
  if (parse.kind !== "sequence" || !parse.defined.has(name)) return [];
  const nl = lineBreak(text);
  const line = `activate ${flowName(name)}`;
  const lastLink = parse.links.length ? parse.span(`link:${parse.links.length - 1}`)?.line : undefined;
  if (lastLink) return [insertLine(text, nextLine(text, lastLink.from), indentAt(text, lastLink.from) + line, nl)];
  return [insertLine(text, topLevelSpot(text, parse), line, nl)];
}

/** `loop label {` ... `}` around messages `from` to `to`, their lines one level in (Visio's combined fragment). */
export function addLoop(text: string, parse: FlowParse, label: string, from: number, to: number): TextEdit[] {
  const value = label.trim();
  if (parse.kind !== "sequence" || !value || /[{}\r\n]/.test(value) || from > to) return [];
  const a = parse.span(`link:${from}`)?.line;
  const b = parse.span(`link:${to}`)?.line;
  if (!a || !b) return [];
  const nl = lineBreak(text);
  // Step 8: a frame that opens on the first message (or closes on the last) and lies inside the new range is wrapped
  // too, so the new loop holds whole frames; one with the same range keeps the new loop inside it.
  const frames = frameSpots(text, parse);
  let open = lineStart(text, a.from);
  let close = lineStart(text, b.from);
  for (const f of frames) {
    if (f.from === from && f.to < to && f.openLine < open) open = f.openLine;
    if (f.to === to && f.from > from && f.closeLine > close) close = f.closeLine;
  }
  const indent = indentAt(text, open);
  const edits: TextEdit[] = [insertLine(text, open, `${indent}loop ${value} {`, nl)];
  for (let p = open; p <= close; p = nextLine(text, p)) if (!isBlankLine(text, p)) edits.push({ from: p, to: p, insert: "  " });
  edits.push(insertLine(text, nextLine(text, close), `${indent}}`, nl));
  return normalize(text, edits);
}

/** `section Name` at the end, with the items it is given moved under it, one level in (timeline sections, T3). */
export function addSection(text: string, parse: FlowParse, name: string, members: readonly string[]): TextEdit[] {
  const value = name.trim();
  if (parse.kind !== "timeline" || !value || /[\r\n]/.test(value) || members.length === 0) return [];
  const nl = lineBreak(text);
  const edits: TextEdit[] = [];
  const moved: string[] = [];
  for (const m of members) {
    const sp = parse.span(`node:${m}`);
    if (!sp) return [];
    let end = lineEnd(text, sp.from);
    while (end > sp.from && isSpace(text[end - 1])) end--;
    moved.push(`  ${text.slice(sp.from, end)}`);
    edits.push(removeLines(text, lineStart(text, sp.from), nextLine(text, sp.from)));
  }
  const block = [`section ${value}`, ...moved].join(nl);
  const tail = text.length === 0 || text.endsWith("\n") ? `${block}${nl}` : `${nl}${block}`;
  edits.push({ from: text.length, to: text.length, insert: tail });
  return normalize(text, edits);
}

/** `base` when it is free, else `base 2`, `base 3`, and so on; in an ER diagram `base_2`, `base_3` (a plain SQL name). */
export function uniqueName(parse: FlowParse, base: string): string {
  if (parse.kind === "er") return sqlFreeName(base, parse.defined.keys());
  if (!parse.defined.has(base)) return base;
  for (let n = 2; ; n++) if (!parse.defined.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** One of the ER column ops. */
function columnEdit(text: string, parse: FlowParse, edit: Extract<FlowEditOp, { table: string }>): FlowEditResult {
  switch (edit.op) {
    case "addColumn":
      return addColumn(text, parse, edit.table, edit.at, edit.before, edit.name, edit.type, edit.flags);
    case "setColumn":
      return setColumn(text, parse, edit.table, edit.index, edit.column, edit.name, edit.type);
    case "setColumnFlag":
      return setColumnFlag(text, parse, edit.table, edit.index, edit.column, edit.flag, edit.on);
    case "duplicateColumn":
      return duplicateColumn(text, parse, edit.table, edit.index, edit.column);
    case "deleteColumn":
      return deleteColumn(text, parse, edit.table, edit.index, edit.column);
  }
}

/** Runs one canvas action against the parse of `text`. */
export function applyFlowEdit(text: string, parse: FlowParse, edit: FlowEditOp): FlowEditResult {
  // An old ER frame is rewritten as table blocks first, so no edit writes next to its old lines.
  if (oldErFrame(parse)) return refused(ER_NOTES.oldForm);
  switch (edit.op) {
    case "addNode": {
      // A new ER table is numbered from 1 (`table_1`), as a new column of a SQL table would be.
      const name = !edit.unique ? edit.name : parse.kind === "er" ? sqlFreeName(edit.name, parse.defined.keys(), 1) : uniqueName(parse, edit.name);
      if (parse.kind === "er" && !edit.under && !edit.after) {
        // A table's kind goes unsaid, so a table with no attributes is a bare line.
        const table = edit.kind === null || edit.kind === "entity" || edit.kind === "weak";
        const bare = (edit.kind === null || edit.kind === "entity") && Object.keys(edit.attrs ?? {}).length === 0;
        const clash = bareColumnClash(text, parse, undefined, [{ name, table, bare }]);
        if (clash) return refused(clash);
      }
      return { edits: addNode(text, parse, name, edit.kind, edit.attrs ?? {}, edit.group, edit.before, { date: edit.date, until: edit.until, under: edit.under, after: edit.after }), name };
    }
    case "addGroup": {
      const name = edit.unique ? uniqueName(parse, edit.name) : edit.name;
      return { edits: addGroup(text, parse, name, edit.group), name };
    }
    case "addLink": {
      const why = addLinkNote(text, parse, edit.from, edit.to, edit.arrow, edit.fromColumn, edit.toColumn);
      if (why) return refused(why);
      return { edits: addLink(text, parse, edit.from, edit.to, edit.arrow, edit.label, edit.fromColumn, edit.toColumn) };
    }
    case "renameNode": {
      if (edit.old !== edit.next && parse.definedTwice.has(edit.old)) return refused(`${edit.old} is defined twice. Fix that first.`);
      const why = erRenameNote(text, parse, edit.old, edit.next);
      if (why) return refused(why);
      return { edits: renameNode(text, parse, edit.old, edit.next) };
    }
    case "deleteNode":
      return { edits: deleteNode(text, parse, edit.name) };
    case "moveToGroup":
      return { edits: moveToGroup(text, parse, edit.name, edit.group) };
    case "setAttr":
      return { edits: setAttr(text, parse, edit.name, edit.key, edit.value) };
    case "setLinkColor":
      return onLink(parse, edit.link, (i) => ({ edits: setLinkColor(text, parse, i, edit.color) }));
    case "setLinkLabel":
      if (edit.link) return onLink(parse, edit.link, (i) => ({ edits: setLinkLabel(text, parse, i, edit.label) }));
      return { edits: setLinkLabel(text, parse, edit.index, edit.label) };
    case "deleteLink":
      return { edits: deleteLink(text, parse, edit.index) };
    case "setLinkArrow":
      return onLink(parse, edit.link, (i) => {
        if (parse.kind && !ARROWS[parse.kind].includes(edit.arrow)) return { edits: [], note: LINK_NOTES.arrow(edit.arrow) };
        return { edits: setLinkArrow(text, parse, i, edit.arrow) };
      });
    case "reverseLink":
      return onLink(parse, edit.link, (i) => {
        const l = parse.links[i];
        if ([l.from, l.to].some((n) => parse.kind === "state" && isStateMarker(n))) return { edits: [], note: LINK_NOTES.reverseMarker };
        if (l.from === l.to) return { edits: [] };
        return { edits: reverseLink(text, parse, i) };
      });
    case "setLinkEnd":
      return onLink(parse, edit.link, (i) => {
        const node = edit.node;
        // A composite's own marker is only its lines' (I4): a line end is not moved onto one.
        if (parse.kind === "state" && isStateMarker(node) && node !== STATE_START && node !== STATE_END) return { edits: [], note: LINK_NOTES.marker };
        if (node === STATE_START || node === STATE_END) {
          if (parse.kind !== "state" || (node === STATE_START) !== (edit.end === "from")) return { edits: [], note: LINK_NOTES.marker };
        } else if (!parse.defined.has(node)) return { edits: [], note: LINK_NOTES.unknown(node) };
        if (edit.column !== undefined && (parse.kind !== "er" || !columnNames(text, parse, node).includes(edit.column))) return { edits: [], note: LINK_NOTES.unknown(`${node}.${edit.column}`) };
        if (edit.column !== undefined && needsQuotes(node)) return refused(ER_NOTES.quotedEnd(node));
        if (edit.column !== undefined && !columnEndReads(parse, node, edit.column)) return refused(ER_NOTES.endMoves(`${node}.${edit.column}`));
        // Fix round 2, N1: inside a composite's braces [*] is the composite's own, so a line ended on the diagram's start or
        // end moves out of the braces.
        if (parse.kind === "state" && (node === STATE_START || node === STATE_END)) {
          const out = moveOutForMarker(text, parse, i, edit.end, node);
          if (out) return out;
        }
        return { edits: setLinkEnd(text, parse, i, edit.end, node, edit.column) };
      });
    case "addColumn":
    case "setColumn":
    case "setColumnFlag":
    case "duplicateColumn":
    case "deleteColumn":
      return columnEdit(text, parse, edit);
    case "addMember":
      return { edits: addMember(text, parse, edit.owner, edit.at, edit.member) };
    case "setMember":
      return { edits: setMember(text, parse, edit.owner, edit.index, edit.was, edit.member) };
    case "duplicateMember":
      return { edits: duplicateMember(text, parse, edit.owner, edit.index, edit.was) };
    case "deleteMember":
      return { edits: deleteMember(text, parse, edit.owner, edit.index, edit.was) };
    case "setDate":
      return { edits: setDate(text, parse, edit.name, edit.date, edit.until) };
    case "ungroup":
      return { edits: ungroup(text, parse, edit.name) };
    case "deleteGroup":
      return { edits: deleteGroup(text, parse, edit.name) };
    case "addActivation":
      return { edits: addActivation(text, parse, edit.name) };
    case "addLoop": {
      const cut = loopCut(parse, edit.from, edit.to);
      if (cut !== null) return { edits: [], note: LOOP_CUT(cut) };
      return { edits: addLoop(text, parse, edit.label, edit.from, edit.to) };
    }
    case "addSection":
      return { edits: addSection(text, parse, edit.name, edit.members) };
    case "moveTopic":
      return { edits: moveTopic(text, parse, edit.name, edit.parent, edit.index) };
    case "deleteTopic":
      return { edits: deleteTopic(text, parse, edit.name) };
    case "addMessage":
      return { edits: addMessage(text, parse, edit.from, edit.to, edit.at, edit.arrow ?? "->", !!edit.inside) };
    case "moveMessage": {
      const why = parse.kind === "sequence" ? chainNote(text, parse, edit.index) : null;
      if (why) return { edits: [], note: why };
      return { edits: moveMessage(text, parse, edit.index, edit.at) };
    }
    case "moveParticipant":
      return { edits: moveParticipant(text, parse, edit.name, edit.before) };
    case "setFrameLabel":
      return { edits: setFrameLabel(text, parse, edit.index, edit.was, edit.label) };
    case "unwrapFrame":
      return { edits: unwrapFrame(text, parse, edit.index, edit.was) };
  }
}
