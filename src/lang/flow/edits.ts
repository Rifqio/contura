// Canvas actions as text edits (spec section 2, "Edits from the canvas"). Each function reads the parse of the
// current text, so it works while the text has errors, and returns the smallest change: untouched lines stay
// byte for byte. In the app they run in the language worker against its cached parse (ruling P5).
import type { TextEdit } from "../protocol";
import {
  ARROWS,
  ATTR_DIAGRAMS,
  ATTR_KEYS,
  attrItems,
  attrValue,
  type DiagramKind,
  type FlowArrow,
  type FlowAttrKey,
  type FlowLink,
  type FlowNodeKind,
  flowLabel,
  flowName,
  nodeStatement,
  isPaletteName,
  isStateMarker,
  isStateStart,
  type PaletteName,
  STATE_END,
  STATE_START,
} from "./model";
import { addMessage, addTopicAfter, chainNote, deleteTopic, frameSpots, LOOP_CUT, loopCut, moveMessage, moveParticipant, moveTopic, setFrameLabel, unwrapFrame } from "./orderEdits";
import type { FlowParse, FlowRange, RowSpan } from "./parse";

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
  | { op: "addLink"; from: string; to: string; arrow: FlowArrow; label?: string }
  | { op: "renameNode"; old: string; next: string }
  | { op: "deleteNode"; name: string }
  | { op: "moveToGroup"; name: string; group: string | null }
  | { op: "setAttr"; name: string; key: "kind" | FlowAttrKey; value: string | null }
  // Step 11: a line's colour by its ref (`A > B: no [color: warning]`); null clears it.
  | { op: "setLinkColor"; link: LinkRef; color: PaletteName | null }
  // A line's label by its ref (the in-place field), as the line ops find their line.
  | { op: "setLinkLabel"; index: number; label: string | null; link?: LinkRef }
  | { op: "deleteLink"; index: number }
  // A line's arrow, direction and ends (diagram step 4, F8 and CL2).
  | { op: "setLinkArrow"; link: LinkRef; arrow: FlowArrow }
  | { op: "reverseLink"; link: LinkRef }
  | { op: "setLinkEnd"; link: LinkRef; end: "from" | "to"; node: string }
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
 * After the last node that is in no group, past its own lines (a class's members); else after the first line; else
 * at the end.
 */
function topLevelSpot(s: string, parse: FlowParse, except?: string): number {
  let at = -1;
  for (const name of parse.defined.keys()) {
    if (name === except || parse.parentOf(name) !== null) continue;
    const sp = parse.span(`node:${name}`);
    if (!sp) continue;
    at = sp.from;
    for (const row of parse.rowsOf(name)) if (row.line.from > at) at = row.line.from;
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
  if (group) {
    const spot = groupSpot(text, parse, group);
    return spot ? [insertLine(text, spot.pos, `${spot.indent}${flowName(name)} {${nl}${spot.indent}}`, nl)] : [];
  }
  return [insertLine(text, topLevelSpot(text, parse), `${flowName(name)} {${nl}}`, nl)];
}

/**
 * A new link line after the last link that sits where this one may: outside every group, or in the group that
 * holds both ends. With no such link it goes at the end, after a blank line.
 */
export function addLink(text: string, parse: FlowParse, from: string, to: string, arrow: FlowArrow, label?: string): TextEdit[] {
  const nl = lineBreak(text);
  // A state diagram's start and end markers are written `[*]` (ST1).
  const endOf = (n: string) => (parse.kind === "state" && isStateMarker(n) ? "[*]" : flowName(n));
  const line = `${endOf(from)} ${arrow} ${endOf(to)}${label ? `: ${flowLabel(label)}` : ""}`;
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
  const insert = flowName(next);
  const edits: TextEdit[] = [];
  const seen = new Set<number>();
  const add = (r: FlowRange | undefined) => {
    if (!r || seen.has(r.from)) return;
    seen.add(r.from);
    edits.push({ from: r.from, to: r.to, insert });
  };
  add((parse.span(`node:${old}`) ?? parse.span(`group:${old}`))?.name);
  // Its own extra lines (class members) name it too.
  for (const row of parse.rowsOf(old)) add(row.name);
  parse.links.forEach((l, i) => {
    if (l.from !== old && l.to !== old) return;
    const sp = parse.span(`link:${i}`);
    // In a chain, one name ends one link and starts the next: `seen` writes it once.
    if (l.from === old) add(sp?.fromName);
    if (l.to === old) add(sp?.toName);
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
  const removals: TextEdit[] = [removeStatement(text, sp.from, sp.to)];
  // A class's members go with it.
  for (const row of parse.rowsOf(name)) removals.push(removeStatement(text, row.line.from, row.line.to));
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

/** Moves a node line into `group`, or out of every group with null. Its comment goes with it. */
export function moveToGroup(text: string, parse: FlowParse, name: string, group: string | null): TextEdit[] {
  if (!parse.span(`node:${name}`) && parse.span(`group:${name}`)) return moveGroupBlock(text, parse, name, group);
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
}

/** True when link `l` has the ends and label of `r`. */
function sameLine(l: FlowLink, r: { from: string; to: string; label?: string | null }): boolean {
  return l.from === r.from && l.to === r.to && (l.label ?? null) === (r.label ?? null);
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
  return { from: l.from, to: l.to, label, nth };
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
  const sp = parse.span(`link:${index}`)!;
  return [{ from: sp.arrow!.from, to: sp.arrow!.to, insert: arrow }];
}

/**
 * Step 11: sets (or clears, null) link `index`'s colour, written `[color: name]` after its label. A link inside a
 * chain is first split onto its own line, so only it takes the colour.
 */
export function setLinkColor(text: string, parse: FlowParse, index: number, color: PaletteName | null): TextEdit[] {
  const sp = Number.isInteger(index) && index >= 0 ? parse.span(`link:${index}`) : null;
  if (!sp?.toName || !sp.line || !parse.kind || !ATTR_DIAGRAMS.has(parse.kind)) return [];
  if (color !== null && !isPaletteName(color)) return [];
  const link = parse.links[index];
  if (link.tree || (link.color ?? null) === color) return [];
  const written = color === null ? "" : `[color: ${color}]`;
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

/** Swaps link `index`'s two ends (draw.io's Reverse). */
export function reverseLink(text: string, parse: FlowParse, index: number): TextEdit[] {
  const at = linkNames(text, parse, index);
  if (!at) return [];
  return rewriteLink(text, parse, index, { from: at.to, arrow: at.arrow, to: at.from });
}

/**
 * Moves one end of link `index` onto `node` (a drag of the line's end, as draw.io reattaches). A state diagram's
 * markers are written `[*]`, the start only as a `from` and the end only as a `to`.
 */
export function setLinkEnd(text: string, parse: FlowParse, index: number, end: "from" | "to", node: string): TextEdit[] {
  const at = linkNames(text, parse, index);
  if (!at) return [];
  const link = parse.links[index];
  if ((end === "from" ? link.from : link.to) === node) return [];
  let written: string;
  if (node === STATE_START || node === STATE_END) {
    if (parse.kind !== "state" || (node === STATE_START) !== (end === "from")) return [];
    written = "[*]";
  } else {
    if (!parse.defined.has(node)) return [];
    written = flowName(node);
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

// ----- class members (diagram step 3, CL1)

/** A class, interface or enum the canvas can write members for. */
function memberOwner(parse: FlowParse, owner: string): boolean {
  const n = parse.doc?.nodes.find((x) => x.name === owner) ?? null;
  return parse.kind === "class" && !!parse.span(`node:${owner}`) && !parse.definedTwice.has(owner) && (!n || n.kind === "class" || n.kind === "interface" || n.kind === "enum");
}

/** Where a member line's text is, after `Owner :`. */
function memberText(text: string, row: RowSpan): FlowRange {
  let from = text.indexOf(":", row.name.to) + 1;
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
function blockLines(text: string, parse: FlowParse, name: string): { from: number; to: number } | null {
  const sp = parse.span(`group:${name}`);
  if (!sp?.open || !sp.close || parse.definedTwice.has(name)) return null;
  return { from: lineStart(text, sp.from), to: nextLine(text, sp.close.from) };
}

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
  const block = blockLines(text, parse, name);
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

/** `base` when it is free, else `base 2`, `base 3`, and so on. */
export function uniqueName(parse: FlowParse, base: string): string {
  if (!parse.defined.has(base)) return base;
  for (let n = 2; ; n++) if (!parse.defined.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Runs one canvas action against the parse of `text`. */
export function applyFlowEdit(text: string, parse: FlowParse, edit: FlowEditOp): FlowEditResult {
  switch (edit.op) {
    case "addNode": {
      const name = edit.unique ? uniqueName(parse, edit.name) : edit.name;
      return { edits: addNode(text, parse, name, edit.kind, edit.attrs ?? {}, edit.group, edit.before, { date: edit.date, until: edit.until, under: edit.under, after: edit.after }), name };
    }
    case "addGroup": {
      const name = edit.unique ? uniqueName(parse, edit.name) : edit.name;
      return { edits: addGroup(text, parse, name, edit.group), name };
    }
    case "addLink":
      return { edits: addLink(text, parse, edit.from, edit.to, edit.arrow, edit.label) };
    case "renameNode":
      return { edits: renameNode(text, parse, edit.old, edit.next) };
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
        // Fix round 2, N1: inside a composite's braces [*] is the composite's own, so a line ended on the diagram's start or
        // end moves out of the braces.
        if (parse.kind === "state" && (node === STATE_START || node === STATE_END)) {
          const out = moveOutForMarker(text, parse, i, edit.end, node);
          if (out) return out;
        }
        return { edits: setLinkEnd(text, parse, i, edit.end, node) };
      });
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
