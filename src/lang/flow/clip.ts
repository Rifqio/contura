// Copy and paste on the diagram canvas (diagram-ux-research F2, draw.io's Ctrl+C, Ctrl+V and Ctrl+D). The clipboard
// holds plain .flow lines: the copied shapes' statements (an ER table with its columns, a class with its members),
// then the lines between copied shapes. A paste reads clipboard text only as .flow lines of the open diagram's kind,
// refuses anything else, and writes the shapes with free names (`Step 2`) where new shapes go, their lines with the
// others. It runs in the language worker against the cached parse, as the other canvas actions do.
import type { TextEdit } from "../protocol";
import { insertLine, lastLinkIn, lineBreak, nextLine, normalize } from "./edits";
import {
  columnFlagsText,
  DIAGRAM_KINDS,
  type DiagramKind,
  type FlowDoc,
  type FlowLink,
  type FlowNode,
  flowLabel,
  flowName,
  flowValue,
  MAX_FLOW_NODES,
  nodeStatement,
  overTextLimit,
  STATE_END,
  STATE_START,
  sqlFreeName,
  linkEndText,
} from "./model";
import { type FlowParse, parseFlow } from "./parse";

/** Where a mind map paste goes: under a topic (its children), or after one (its siblings, as a duplicate). */
export type PastePlace = { under: string } | { after: string };

const isMarker = (name: string) => name === STATE_START || name === STATE_END;

/** A line end as written: a state diagram's start and end markers are both `[*]`. */
const endText = (name: string) => (isMarker(name) ? "[*]" : flowName(name));

function linkText(l: FlowLink, from: string, to: string): string {
  // An ER relationship's columns go with its ends (ER build C).
  const a = l.fromColumn === undefined ? endText(from) : linkEndText(from, l.fromColumn);
  const b = l.toColumn === undefined ? endText(to) : linkEndText(to, l.toColumn);
  return `${a} ${l.arrow} ${b}${l.label ? `: ${flowLabel(l.label)}` : ""}`;
}

/** A node's statement under `name`; a flowchart step leaves its kind unsaid, as it is usually written. */
function statementOf(kind: DiagramKind, n: FlowNode, name: string): string {
  if (kind === "flow" && n.kind === "step") {
    const parts = Object.entries(n.attrs).map(([k, v]) => `${k}: ${flowValue(v)}`);
    return parts.length ? `${flowName(name)} [${parts.join(", ")}]` : flowName(name);
  }
  return nodeStatement(kind, { ...n, name });
}

/** A node's own extra lines under `name`: an ER table's columns with their keys, a class's members. */
function rowsOf(kind: DiagramKind, n: FlowNode, name: string): string[] {
  const rows = n.rows ?? [];
  if (kind === "er") return rows.map((r, i) => `${name}.${r}${columnFlagsText(n.rowFlags?.[i] ?? [])}`);
  if (kind === "class") return rows.map((r) => `${flowName(name)} : ${r}`);
  return [];
}

/** A mind map topic at `depth` (the central idea copied comes back as a topic). */
const topicLine = (name: string, depth: number) => `${"  ".repeat(Math.max(1, depth))}${flowName(name)}`;

/**
 * The .flow lines of the shapes `names` in `doc`, for the clipboard: each shape's statement with its own extra lines,
 * then every line whose two ends were both copied (draw.io copies the connectors between copied shapes). A mind map's
 * topics keep their shape, the shallowest one level under the central idea. Empty when nothing copyable is named.
 */
export function copyLines(doc: FlowDoc, names: readonly string[]): string {
  const picked = new Set(names);
  const nodes = doc.nodes.filter((n) => picked.has(n.name) && !isMarker(n.name));
  const out: string[] = [];
  if (doc.kind === "mindmap") {
    const topics = nodes.filter((n) => n.kind !== "note");
    const min = Math.min(...topics.map((n) => n.depth ?? 0));
    let prev = 0;
    for (const n of nodes) {
      if (n.kind === "note") {
        out.push(statementOf(doc.kind, n, n.name));
        continue;
      }
      // Never more than one level below the topic before it, so a gap in what was picked still reads as a tree.
      const depth = Math.min((n.depth ?? 0) - min + 1, prev + 1);
      prev = depth;
      out.push(topicLine(n.name, depth));
    }
  } else {
    for (const n of nodes) out.push(statementOf(doc.kind, n, n.name), ...rowsOf(doc.kind, n, n.name));
  }
  if (out.length === 0) return "";
  for (const l of doc.links) if (!l.tree && picked.has(l.from) && picked.has(l.to)) out.push(linkText(l, l.from, l.to));
  return `${out.join("\n")}\n`;
}

/** `name` when it is free, else the next free `base N`, counting on from a number the name ends with (Step 2, Step 3). */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const m = / (\d+)$/.exec(name);
  const base = m ? name.slice(0, m.index) : name;
  for (let n = m ? Number(m[1]) + 1 : 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** A data flow's next free process (`3.0`) or store (`D2`) id, past every id in `used`. */
function freeId(kind: FlowNode["kind"], used: ReadonlySet<string>): string | null {
  if (kind !== "process" && kind !== "store") return null;
  let max = 0;
  for (const id of used) {
    const m = kind === "process" ? /^(\d+)(?:\.\d+)?$/.exec(id) : /^D(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return kind === "process" ? `${max + 1}.0` : `D${max + 1}`;
}

/** The kind's name in a sentence: "does not hold flowchart lines", "holds a sequence diagram". */
const KIND_WORD: Record<DiagramKind, string> = {
  dfd: "data flow",
  flow: "flowchart",
  cloud: "cloud",
  er: "entity relationship",
  sequence: "sequence",
  state: "state",
  class: "class",
  mindmap: "mind map",
  timeline: "timeline",
};
const KIND_A: Record<DiagramKind, string> = {
  dfd: "a data flow diagram",
  flow: "a flowchart",
  cloud: "a cloud diagram",
  er: "an entity relationship diagram",
  sequence: "a sequence diagram",
  state: "a state diagram",
  class: "a class diagram",
  mindmap: "a mind map",
  timeline: "a timeline",
};

const WHOLE_FILE = new RegExp(`^\\s*diagram\\s+(${DIAGRAM_KINDS.join("|")})\\b`);

/** The clipboard text as a parse of this kind, or why it is not clean .flow lines of it. */
function readClip(kind: DiagramKind, clip: string): FlowDoc | string {
  const body = clip.replace(/^\uFEFF/, "");
  if (body.trim() === "") return "The clipboard has no text to paste.";
  // A whole file (its `diagram <kind>` line first) is read as it is; lines alone are read under this diagram's kind.
  const first = body.split("\n").find((l) => l.trim() !== "") ?? "";
  const whole = WHOLE_FILE.exec(first);
  if (whole && whole[1] !== kind) return `The clipboard holds ${KIND_A[whole[1] as DiagramKind]}, not ${KIND_A[kind]}, so nothing was pasted.`;
  const p = parseFlow(whole ? body : `diagram ${kind} "Clipboard"\n${body}`);
  const error = p.problems.find((x) => x.severity === "error");
  if (error || !p.doc || p.kind !== kind) {
    const line = Math.max(1, (error?.line ?? 1) - (whole ? 0 : 1));
    const missing = error ? /^(.*) is not defined\.$/.exec(error.message) : null;
    if (missing) return `Line ${line} names ${missing[1]}, which is not one of the pasted shapes, so nothing was pasted.`;
    return `The clipboard does not hold ${KIND_WORD[kind]} lines (line ${line}: ${error?.message ?? "no diagram"}), so nothing was pasted.`;
  }
  return p.doc.nodes.some((n) => !isMarker(n.name)) ? p.doc : `The clipboard does not hold ${KIND_WORD[kind]} shapes, so nothing was pasted.`;
}

/** The note shapes the text has (`Note N`, numbered in text order), the last one by place. */
function notesOf(text: string, parse: FlowParse): { count: number; last: string | null } {
  let count = 0;
  let last: string | null = null;
  let at = -1;
  for (const name of parse.defined.keys()) {
    if (!/^Note \d+$/.test(name)) continue;
    const sp = parse.span(`node:${name}`);
    if (!sp || !text.startsWith("note", sp.from)) continue;
    count++;
    if (sp.from > at) {
      at = sp.from;
      last = name;
    }
  }
  return { count, last };
}

/** Just after a note's line; after the `}` of the outermost group around it when it is in one. */
function afterNote(text: string, parse: FlowParse, note: string): number {
  let top: string | null = null;
  for (let g = parse.parentOf(note); g; g = parse.parentOf(g)) top = g;
  if (top === null) return nextLine(text, parse.span(`node:${note}`)!.from);
  const close = parse.span(`group:${top}`)?.close;
  return close ? nextLine(text, close.from) : text.length;
}

/** Where new shapes go: after the last shape outside every group and its own lines; else after the first line. */
function shapeSpot(text: string, parse: FlowParse): number {
  let at = -1;
  for (const name of parse.defined.keys()) {
    if (isMarker(name) || parse.parentOf(name) !== null) continue;
    const sp = parse.span(`node:${name}`);
    if (!sp) continue;
    at = Math.max(at, sp.from, ...parse.rowsOf(name).map((r) => r.line.from));
  }
  if (at >= 0) return nextLine(text, at);
  const header = parse.span("diagram");
  return header ? nextLine(text, header.from) : text.length;
}

/** A mind map paste's place: the line it goes before and the depth of its shallowest topic. */
function mindSpot(text: string, parse: FlowParse, place: PastePlace | undefined): { pos: number; depth: number } {
  const nodes = (parse.doc?.nodes ?? []).filter((n) => n.kind !== "note");
  const root = nodes.find((n) => n.kind === "root");
  const named = place ? ("under" in place ? place.under : place.after) : root?.name;
  const i = nodes.findIndex((n) => n.name === named);
  if (i < 0) return { pos: text.length, depth: 1 };
  const anchor = nodes[i];
  const depth = anchor.depth ?? 0;
  // Its subtree: the topics after it that sit deeper.
  let j = i;
  while (j + 1 < nodes.length && (nodes[j + 1].depth ?? 0) > depth) j++;
  const sp = parse.span(`node:${nodes[j].name}`);
  const pos = sp ? nextLine(text, sp.from) : text.length;
  const under = !place || "under" in place || depth === 0;
  return { pos, depth: under ? depth + 1 : depth };
}

/** Why a clipboard text with too many lines is refused. */
export const TOO_MANY_LINES = "The clipboard text has more than 2,000 lines, so nothing was pasted.";

/** The lines of `text` that hold anything, counted without splitting it. */
export function nonEmptyLines(text: string): number {
  let n = 0;
  let filled = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 10) {
      if (filled) n++;
      filled = false;
    } else if (c !== 32 && c !== 9 && c !== 13) filled = true;
  }
  return filled ? n + 1 : n;
}

/** What a paste writes, each pasted shape's new name, and why it was refused or what it left out. */
export type PasteResult = { edits: TextEdit[]; names: Record<string, string>; note?: string };

/**
 * The edits that paste the clipboard's .flow lines into `text`, and each pasted shape's new name. Every shape gets a
 * free name (a data flow process or store a free id too); lines between pasted shapes follow the new names, and a
 * state diagram's `[*]` stays the diagram's own. A pasted note goes after every note there is, so no note is
 * renumbered. Refused (no edits, with the reason as `note`) when the clipboard is not clean lines of this kind, is
 * over 1 MB, or would make the diagram hold more than 2,000 shapes.
 */
export function pasteLines(text: string, parse: FlowParse, clip: string, place?: PastePlace): PasteResult {
  const refuse = (note: string): PasteResult => ({ edits: [], names: {}, note });
  const kind = parse.kind;
  if (!kind) return refuse("Fix the diagram's first line first, so nothing was pasted.");
  if (overTextLimit(clip)) return refuse("The clipboard text is larger than 1 MB, so nothing was pasted.");
  // O3: a count of the non-empty lines first, so a long list is refused without a parse.
  if (nonEmptyLines(clip) > MAX_FLOW_NODES) return refuse(TOO_MANY_LINES);
  const snip = readClip(kind, clip);
  if (typeof snip === "string") return refuse(snip);
  const shapes = snip.nodes.filter((n) => !isMarker(n.name));
  const now = [...parse.defined.keys()].filter((n) => !isMarker(n) && parse.span(`node:${n}`) !== null).length;
  if (now + shapes.length > MAX_FLOW_NODES) {
    const count = (n: number) => n.toLocaleString("en-US");
    return refuse(`Pasting ${count(shapes.length)} shapes would make ${count(now + shapes.length)} shapes, and a diagram holds at most ${count(MAX_FLOW_NODES)}, so nothing was pasted.`);
  }
  const nl = lineBreak(text);

  // Free names, and for a data flow free ids. Notes are named by their place: the next free numbers.
  const taken = new Set(parse.defined.keys());
  const names: Record<string, string> = Object.create(null);
  const ids = new Set((parse.doc?.nodes ?? []).map((n) => n.attrs.id).filter((id): id is string => !!id));
  const existing = notesOf(text, parse);
  let noteNo = existing.count;
  const renamed = shapes.map((n) => {
    if (n.kind === "note") {
      names[n.name] = `Note ${++noteNo}`;
      return n;
    }
    // An ER table's copy stays a plain SQL name (orders_2), one rule with every other place that names one.
    const name = kind === "er" ? sqlFreeName(n.name, taken) : freeName(n.name, taken);
    taken.add(name);
    names[n.name] = name;
    const id = n.attrs.id;
    if (kind !== "dfd" || !id || !ids.has(id)) {
      if (id) ids.add(id);
      return { ...n, name };
    }
    const next = freeId(n.kind, ids) ?? id;
    ids.add(next);
    return { ...n, name, attrs: { ...n.attrs, id: next } };
  });
  const nameOf = (n: string) => (isMarker(n) ? n : (names[n] ?? n));
  const links = snip.links.filter((l) => !l.tree).map((l) => linkText(l, nameOf(l.from), nameOf(l.to)));
  const noteLines = renamed.filter((n) => n.kind === "note").map((n) => statementOf(kind, n, n.name));
  const shapesOnly = renamed.filter((n) => n.kind !== "note");

  let shapeLines: string[];
  let pos: number;
  if (kind === "mindmap") {
    const spot = mindSpot(text, parse, place);
    pos = spot.pos;
    const min = Math.min(...shapesOnly.map((n) => n.depth ?? 0));
    shapeLines = shapesOnly.map((n) => topicLine(n.name, spot.depth + (n.depth ?? 0) - min));
  } else {
    pos = shapeSpot(text, parse);
    shapeLines = shapesOnly.flatMap((n) => [statementOf(kind, n, n.name), ...rowsOf(kind, n, n.name)]);
  }
  const notePos = existing.last !== null ? afterNote(text, parse, existing.last) : pos;

  // The lines go after the last line outside every group; a sequence's at the end, after any frame.
  const last = kind === "sequence" || kind === "mindmap" ? undefined : lastLinkIn(parse, null);
  const linkPos = last ? nextLine(text, last.from) : text.length;
  // Blocks at the same place are written as one, in this order: shapes, notes, lines.
  const blocks: { pos: number; lines: string[] }[] = [];
  for (const b of [
    { pos, lines: shapeLines },
    { pos: notePos, lines: noteLines },
    { pos: linkPos, lines: links },
  ]) {
    if (b.lines.length === 0) continue;
    const same = blocks.find((x) => x.pos === b.pos);
    if (same) same.lines.push(...b.lines);
    else blocks.push({ pos: b.pos, lines: [...b.lines] });
  }
  const edits = blocks.map((b) => insertLine(text, b.pos, b.lines.join(nl), nl));
  const left = snip.groups.length > 0 ? "Groups are not pasted yet, only the shapes in them." : (snip.frames?.length ?? 0) > 0 ? "Frames are not pasted yet, only the messages in them." : undefined;
  return { edits: normalize(text, edits), names: { ...names }, ...(left ? { note: left } : {}) };
}
