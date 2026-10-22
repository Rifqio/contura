// Canvas actions as text edits (spec section 2, "Edits from the canvas"). Each function reads the parse of the
// current text, so it works while the text has errors, and returns the smallest change: untouched lines stay
// byte for byte. In the app they run in the language worker against its cached parse (ruling P5).
import type { TextEdit } from "../protocol";
import { ATTR_KEYS, type DiagramKind, type FlowArrow, type FlowAttrKey, type FlowLink, type FlowNodeKind, flowLabel, flowName, flowValue, nodeStatement } from "./model";
import type { FlowParse, FlowRange } from "./parse";

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
  | { op: "setLinkLabel"; index: number; label: string | null }
  | { op: "deleteLink"; index: number };

/** The edits, and for an add the name it used. An empty list means the action does not apply to this text. */
export type FlowEditResult = { edits: TextEdit[]; name?: string };

// ----- text helpers

const isBlankChar = (c: string) => c === " " || c === "\t";
const isSpace = (c: string) => /\s/.test(c);

/** The text's own line break, so a CRLF file stays CRLF. */
function lineBreak(s: string): string {
  const i = s.indexOf("\n");
  return i > 0 && s[i - 1] === "\r" ? "\r\n" : "\n";
}

const lineStart = (s: string, p: number) => s.lastIndexOf("\n", p - 1) + 1;

/** The end of the line holding `p`, before its line break. */
function lineEnd(s: string, p: number): number {
  let e = s.indexOf("\n", p);
  if (e < 0) return s.length;
  if (e > p && s[e - 1] === "\r") e--;
  return e;
}

/** The start of the line after the one holding `p`, or the end of the text. */
function nextLine(s: string, p: number): number {
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
function insertLine(s: string, pos: number, line: string, nl: string): TextEdit {
  if (pos >= s.length && s.length > 0 && !s.endsWith("\n")) return { from: s.length, to: s.length, insert: nl + line };
  return { from: pos, to: pos, insert: line + nl };
}

/** Sorted and merged where edits touch, so the list is valid as one CodeMirror change. */
function normalize(s: string, edits: TextEdit[]): TextEdit[] {
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

/** After the last node that is in no group; else after the first line; else at the end. */
function topLevelSpot(s: string, parse: FlowParse, except?: string): number {
  let at = -1;
  for (const name of parse.defined.keys()) {
    if (name === except || parse.parentOf(name) !== null) continue;
    const sp = parse.span(`node:${name}`);
    if (sp) at = sp.from;
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
): TextEdit[] {
  if (parse.defined.has(name)) return [];
  const nl = lineBreak(text);
  const line = nodeText(name, kind, attrs, parse.kind);
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
function lastLinkIn(parse: FlowParse, group: string | null): FlowRange | undefined {
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
      return { edits: addNode(text, parse, name, edit.kind, edit.attrs ?? {}, edit.group), name };
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
      return { edits: setLinkLabel(text, parse, edit.index, edit.label) };
    case "deleteLink":
      return { edits: deleteLink(text, parse, edit.index) };
  }
}
