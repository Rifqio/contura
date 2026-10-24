// Canvas actions as text edits (spec section 2, "Edits from the canvas"). Each function reads the parse of the
// current text, so it works while the text has errors, and returns the smallest change: untouched lines stay
// byte for byte. In the app they run in the language worker against its cached parse (ruling P5).
import type { TextEdit } from "../protocol";
import { ARROWS, ATTR_KEYS, type ColumnFlag, COLUMN_FLAGS, columnFlagsText, type DiagramKind, type FlowArrow, type FlowAttrKey, type FlowLink, type FlowNodeKind, columnsWritable, flowLabel, flowName, flowValue, isColumnName, isColumnType, linkEndText, nodeStatement, sqlFreeName, STATE_END, STATE_START } from "./model";
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
  // ER build C: a relationship's label by its ref (the in-place field), as the line ops find their line.
  | { op: "setLinkLabel"; index: number; label: string | null; link?: LinkRef }
  | { op: "deleteLink"; index: number }
  // A line's arrow, direction and ends (diagram step 4, F8 and CL2; ER step 2.4).
  | { op: "setLinkArrow"; link: LinkRef; arrow: FlowArrow }
  | { op: "reverseLink"; link: LinkRef }
  // An ER relationship's end may land on a column (fix round 1); without one it joins the whole table.
  | { op: "setLinkEnd"; link: LinkRef; end: "from" | "to"; node: string; column?: string }
  // ER columns, by their index in the entity's rows and the name the canvas saw there (ER build A): a text that
  // no longer has that column at that place (a stale drawing) refuses the op.
  | { op: "addColumn"; table: string; at: number; before: string | null; name: string; type: string; flags?: ColumnFlag[] }
  | { op: "setColumn"; table: string; index: number; column: string; name?: string; type?: string }
  | { op: "setColumnFlag"; table: string; index: number; column: string; flag: ColumnFlag; on: boolean }
  | { op: "duplicateColumn"; table: string; index: number; column: string }
  | { op: "deleteColumn"; table: string; index: number; column: string };

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
function lineEnd(s: string, p: number): number {
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

function indentAt(s: string, p: number): string {
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

function isBlankLine(s: string, start: number): boolean {
  const e = lineEnd(s, start);
  for (let i = start; i < e; i++) if (!isSpace(s[i])) return false;
  return true;
}

/** Deletes whole lines `[from, to)`; when blank lines sit on both sides, one of them goes too. */
function removeLines(s: string, from: number, to: number): TextEdit {
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
 * After the last node that is in no group, past its own lines (an ER table's columns, a class's members, ER build
 * C); else after the first line; else at the end.
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
  for (const [key, value] of Object.entries(attrs)) parts.push(`${key}: ${flowValue(value)}`);
  return parts.length ? `${flowName(name)} [${parts.join(", ")}]` : flowName(name);
}

/**
 * Removes the groups, from `start` outwards, that this change leaves empty: nothing but white space between the
 * braces, no comment on either brace line, and no link to the group left. `removals` gains the group lines.
 * The walk stops at `keep`: a group that gets a line from this same change (and so every group around it).
 */
function pruneGroups(
  s: string,
  parse: FlowParse,
  start: string | null | undefined,
  removals: TextEdit[],
  gone: Set<string>,
  keep: ReadonlySet<string> = new Set(),
) {
  const covered = (p: number) => removals.some((r) => r.insert === "" && r.from <= p && p < r.to);
  for (let g = start; g; g = parse.parentOf(g)) {
    if (keep.has(g)) return;
    const sp = parse.span(`group:${g}`);
    if (!sp?.open || !sp.close) return;
    if (commentAfter(s, sp.open.to) >= 0 || commentAfter(s, sp.close.to) >= 0) return;
    const name = g;
    if (parse.links.some((l) => (l.from === name && !gone.has(l.to)) || (l.to === name && !gone.has(l.from)))) return;
    for (let p = sp.open.to; p < sp.close.from; p++) if (!isSpace(s[p]) && !covered(p)) return;
    removals.push(removeLines(s, lineStart(s, sp.from), nextLine(s, sp.close.from)));
    gone.add(g);
  }
}

// ----- the edits

/** A new node line, after the loose nodes or inside `group`. Refused (no edits) when the name is taken. */
export function addNode(
  text: string,
  parse: FlowParse,
  name: string,
  kind: FlowNodeKind | null,
  attrs: Record<string, string> = {},
  group?: string | null,
  before?: string,
): TextEdit[] {
  if (parse.defined.has(name)) return [];
  const nl = lineBreak(text);
  const line = nodeText(name, kind, attrs, parse.kind);
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
  const line = `${flowName(from)} ${arrow} ${flowName(to)}${label ? `: ${flowLabel(label)}` : ""}`;
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
  // Its own extra lines (ER columns, class members) name it too.
  for (const row of parse.rowsOf(old)) add(row.name);
  // An ER relationship's column end (`invoices.customer_id`) keeps its column: only the table's part changes.
  const tablePart = (r: FlowRange | undefined, column: string | undefined) =>
    r && column !== undefined ? (text.slice(r.from, r.from + old.length) === old ? { from: r.from, to: r.from + old.length } : undefined) : r;
  parse.links.forEach((l, i) => {
    if (l.from !== old && l.to !== old) return;
    const sp = parse.span(`link:${i}`);
    // In a chain, one name ends one link and starts the next: `seen` writes it once.
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
  const removals: TextEdit[] = [removeStatement(text, sp.from, sp.to)];
  // An ER entity's columns and a class's members go with it.
  for (const row of parse.rowsOf(name)) removals.push(removeStatement(text, row.line.from, row.line.to));
  removeLinks(text, parse, (l) => gone.has(l.from) || gone.has(l.to), removals, nl);
  pruneGroups(text, parse, parse.parentOf(name), removals, gone);
  return normalize(text, removals);
}

/** Removes the links `drop` picks (by link and index); a chain statement is rewritten as the runs it keeps, one per line. */
function removeLinks(s: string, parse: FlowParse, drop: (link: FlowLink, index: number) => boolean, edits: TextEdit[], nl: string) {
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
  // The target and every group around it get the line, so none of them is emptied by the move.
  const keep = new Set<string>();
  for (let g: string | null | undefined = group; g; g = parse.parentOf(g)) keep.add(g);
  pruneGroups(text, parse, from, edits, new Set(), keep);
  return normalize(text, edits);
}

/**
 * Sets an attribute of a node or group (`id`, `icon`, `color`, `table`, or `kind` for the kind word); null removes
 * it, and the brackets go with the last item.
 */
export function setAttr(text: string, parse: FlowParse, name: string, key: "kind" | FlowAttrKey, value: string | null): TextEdit[] {
  // Only the grammar's keys: anything else would write an attribute the parser refuses.
  if (key !== "kind" && !(ATTR_KEYS as readonly string[]).includes(key)) return [];
  const sp = parse.span(`node:${name}`) ?? parse.span(`group:${name}`);
  if (!sp?.name) return [];
  const item = (v: string) => (key === "kind" ? v : `${key}: ${flowValue(v)}`);
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
    return [{ from: existing.from, to: existing.to, insert: key === "kind" ? value : flowValue(value) }];
  }
  if (value === null) return [];
  if (inner === "") return [{ from: attrs.from + 1, to: innerTo, insert: item(value) }];
  if (key === "kind") return [{ from: attrs.from + 1, to: attrs.from + 1, insert: `${value}, ` }];
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
  /** An ER relationship's columns (ER build C): two lines between the same tables differ by them. */
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
    return `${from} ${arrow} ${to}${label}`;
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

/** An ER relationship read from its other end: `1--*` becomes `*--1`, so each table keeps its end. */
const REVERSED: Partial<Record<FlowArrow, FlowArrow>> = { "1--*": "*--1", "*--1": "1--*" };

/** Swaps link `index`'s two ends (draw.io's Reverse); an ER relationship's ends swap with them (board ER interactions). */
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
    written = linkEndText(node, column);
  }
  return rewriteLink(text, parse, index, end === "from" ? { ...at, from: written } : { ...at, to: written });
}

// ----- ER columns

/** An entity the canvas can write columns for: a plain name with no dot, so `table.column` reads back. */
function columnOwner(parse: FlowParse, table: string): boolean {
  return parse.kind === "er" && !!parse.span(`node:${table}`) && !parse.definedTwice.has(table) && columnsWritable(table);
}

/** A column line's name and type, read from the text after `table.`. */
function columnParts(text: string, row: RowSpan): { name: string; type: string } {
  const body = text.slice(row.name.to + 1, row.line.to).trim();
  const at = body.search(/\s/);
  return at < 0 ? { name: body, type: "" } : { name: body.slice(0, at), type: body.slice(at + 1).trim() };
}

/** The flags written in a column's list, as the parser reads them. */
function columnFlagsOf(text: string, row: RowSpan): Set<ColumnFlag> {
  const out = new Set<ColumnFlag>();
  if (!row.flags) return out;
  for (const item of text.slice(row.flags.from + 1, row.flags.to - 1).split(",")) {
    const word = item.trim().toLowerCase().split(/\s+/).join(" ");
    if ((COLUMN_FLAGS as readonly string[]).includes(word)) out.add(word as ColumnFlag);
  }
  return out;
}

/** The column at `index` when the text still has `column` there; else undefined. */
function columnAt(text: string, parse: FlowParse, table: string, index: number, column: string): RowSpan | undefined {
  if (!columnOwner(parse, table)) return undefined;
  const row = parse.rowsOf(table)[index];
  return row && columnParts(text, row).name === column ? row : undefined;
}

/** True when another column of the table already has this name, in any case. */
function columnTaken(text: string, rows: readonly RowSpan[], name: string, except = -1): boolean {
  const lower = name.toLowerCase();
  return rows.some((r, i) => i !== except && columnParts(text, r).name.toLowerCase() === lower);
}

/** A new column line before the column at `at`, or after the last one (after the table's line when it has none). */
export function addColumn(
  text: string,
  parse: FlowParse,
  table: string,
  at: number,
  before: string | null,
  name: string,
  type: string,
  flags: readonly ColumnFlag[] = [],
): TextEdit[] {
  if (!columnOwner(parse, table) || !isColumnName(name) || !isColumnType(type)) return [];
  const rows = parse.rowsOf(table);
  if (columnTaken(text, rows, name)) return [];
  // The place the canvas saw: before that column, or after the last one.
  if (before === null ? at < rows.length : !rows[at] || columnParts(text, rows[at]).name !== before) return [];
  const node = parse.span(`node:${table}`)!;
  const ref = at >= 0 && at < rows.length ? rows[at].line.from : rows.length > 0 ? rows[rows.length - 1].line.from : node.from;
  const pos = at >= 0 && at < rows.length ? lineStart(text, ref) : nextLine(text, ref);
  const line = `${indentAt(text, ref)}${table}.${name}${type ? ` ${type}` : ""}${columnFlagsText(flags)}`;
  return [insertLine(text, pos, line, lineBreak(text))];
}

/** Renames or retypes one column in place; its flags and any comment after it stay. */
export function setColumn(text: string, parse: FlowParse, table: string, index: number, column: string, name?: string, type?: string): TextEdit[] {
  const row = columnAt(text, parse, table, index, column);
  if (!row) return [];
  const rows = parse.rowsOf(table);
  const cur = columnParts(text, row);
  const nextName = name ?? cur.name;
  const nextType = type ?? cur.type;
  if (!isColumnName(nextName) || !isColumnType(nextType) || columnTaken(text, rows, nextName, index)) return [];
  if (nextName === cur.name && nextType === cur.type) return [];
  // Only the name's or the type's own span changes; the spacing between them stays as written.
  const nameFrom = row.name.to + 1;
  const nameTo = nameFrom + cur.name.length;
  const edits: TextEdit[] = [];
  if (nextName !== cur.name) {
    edits.push({ from: nameFrom, to: nameTo, insert: nextName });
    // A6: the relationships that name the column follow it, in the same edit list. In a chain one name ends one
    // link and starts the next: `seen` writes it once (fix round 2, I3).
    const seen = new Set<number>();
    parse.links.forEach((l, i) => {
      const sp = parse.span(`link:${i}`);
      const column = (r: FlowRange | undefined) => {
        if (!r || seen.has(r.from)) return;
        seen.add(r.from);
        edits.push({ from: r.from + table.length + 1, to: r.to, insert: nextName });
      };
      if (l.from === table && l.fromColumn === cur.name) column(sp?.fromName);
      if (l.to === table && l.toColumn === cur.name) column(sp?.toName);
    });
  }
  if (nextType !== cur.type) {
    if (!cur.type) edits.push({ from: nameTo, to: nameTo, insert: ` ${nextType}` });
    else if (!nextType) edits.push({ from: nameTo, to: row.line.to, insert: "" });
    else edits.push({ from: row.line.to - cur.type.length, to: row.line.to, insert: nextType });
  }
  return normalize(text, edits);
}

/** Turns one flag on or off and writes the list as `[pk, not null, unique]`; the other flags stay as they are. */
export function setColumnFlag(text: string, parse: FlowParse, table: string, index: number, column: string, flag: ColumnFlag, on: boolean): TextEdit[] {
  const row = columnAt(text, parse, table, index, column);
  // An unclosed list is a problem already: the writer leaves it to the text.
  if (!row || (row.flags && text[row.flags.to - 1] !== "]")) return [];
  const before = columnFlagsOf(text, row);
  const after = new Set(before);
  if (on) after.add(flag);
  else after.delete(flag);
  const insert = columnFlagsText(after);
  if (insert === columnFlagsText(before)) return [];
  return [{ from: row.line.to, to: row.flags?.to ?? row.line.to, insert }];
}

/** A copy of the column below it, named `name_copy` (then `name_copy2`, ...), not a key (draw.io's Ctrl+Enter). */
export function duplicateColumn(text: string, parse: FlowParse, table: string, index: number, column: string): TextEdit[] {
  const row = columnAt(text, parse, table, index, column);
  if (!row) return [];
  const rows = parse.rowsOf(table);
  const cur = columnParts(text, row);
  let name = `${cur.name}_copy`;
  for (let n = 2; columnTaken(text, rows, name); n++) name = `${cur.name}_copy${n}`;
  const flags = columnFlagsOf(text, row);
  if (flags.delete("pk")) flags.add("not null");
  const next = rows[index + 1];
  return addColumn(text, parse, table, index + 1, next ? columnParts(text, next).name : null, name, cur.type, [...flags]);
}

/** Deletes one column's line, with a comment on that line. */
export function deleteColumn(text: string, parse: FlowParse, table: string, index: number, column: string): TextEdit[] {
  const row = columnAt(text, parse, table, index, column);
  if (!row) return [];
  // A comment on the column's own line is about the column: it goes with it.
  const edits = [removeLines(text, lineStart(text, row.line.from), nextLine(text, row.line.from))];
  // So do the relationships that use it (ER build C).
  const uses = (l: FlowLink) => (l.from === table && l.fromColumn === column) || (l.to === table && l.toColumn === column);
  if (parse.links.some(uses)) removeLinks(text, parse, uses, edits, lineBreak(text));
  return normalize(text, edits);
}

/** `base` when it is free, else `base 2`, `base 3`, and so on; an ER table `base_2`, `base_3` (a plain SQL name). */
export function uniqueName(parse: FlowParse, base: string): string {
  if (parse.kind === "er") return sqlFreeName(base, parse.defined.keys());
  if (!parse.defined.has(base)) return base;
  for (let n = 2; ; n++) if (!parse.defined.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Runs one canvas action against the parse of `text`. */
export function applyFlowEdit(text: string, parse: FlowParse, edit: FlowEditOp): FlowEditResult {
  switch (edit.op) {
    case "addNode": {
      const name = edit.unique ? uniqueName(parse, edit.name) : edit.name;
      return { edits: addNode(text, parse, name, edit.kind, edit.attrs ?? {}, edit.group, edit.before), name };
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
        if ([l.from, l.to].some((n) => n === STATE_START || n === STATE_END)) return { edits: [], note: LINK_NOTES.reverseMarker };
        if (l.from === l.to) return { edits: [] };
        return { edits: reverseLink(text, parse, i) };
      });
    case "setLinkEnd":
      return onLink(parse, edit.link, (i) => {
        const node = edit.node;
        if (node === STATE_START || node === STATE_END) {
          if (parse.kind !== "state" || (node === STATE_START) !== (edit.end === "from")) return { edits: [], note: LINK_NOTES.marker };
        } else if (!parse.defined.has(node)) return { edits: [], note: LINK_NOTES.unknown(node) };
        if (edit.column !== undefined) {
          const rows = parse.doc?.nodes.find((n) => n.name === node)?.rows ?? [];
          if (parse.kind !== "er" || !rows.some((r) => r.split(/\s/)[0] === edit.column)) return { edits: [], note: LINK_NOTES.unknown(`${node}.${edit.column}`) };
        }
        return { edits: setLinkEnd(text, parse, i, edit.end, node, edit.column) };
      });
    case "addColumn":
      return { edits: addColumn(text, parse, edit.table, edit.at, edit.before, edit.name, edit.type, edit.flags) };
    case "setColumn":
      return { edits: setColumn(text, parse, edit.table, edit.index, edit.column, edit.name, edit.type) };
    case "setColumnFlag":
      return { edits: setColumnFlag(text, parse, edit.table, edit.index, edit.column, edit.flag, edit.on) };
    case "duplicateColumn":
      return { edits: duplicateColumn(text, parse, edit.table, edit.index, edit.column) };
    case "deleteColumn":
      return { edits: deleteColumn(text, parse, edit.table, edit.index, edit.column) };
  }
}
