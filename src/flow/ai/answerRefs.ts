import type { FlowOutline } from "../../api/types";
import { INLINE } from "../../assistant/answerMarkdown";
import { type FlowDoc, type FlowGroup, splitRow } from "../../lang/flow/model";

/** What an answer can name in one frame: its shapes and groups, and each table's columns. */
export type PartFrame = { title: string; names: ReadonlySet<string>; columns: ReadonlyMap<string, ReadonlySet<string>>; clash?: boolean };

/**
 * A backticked name in an answer: `from` to `to` is the code's own text (the ticks left out), `at` the frame's place
 * in the list the answer was read against (a title may repeat, so the place says which), `frame` its title. `column`
 * is set when the name was `table.column`; `name` is then the table.
 */
export type PartLink = { from: number; to: number; frame: string; name: string; column: string | null; at: number };

const LINE_END = /\r\n|\r|\n/g;
const FENCE_LEAD = /^[ \t]+/;
const FENCE_BLANK = /^[ \t]*$/;

/**
 * The inline code of an answer outside its fenced blocks, in text order: the code's range and text. A fence opens and
 * closes as `parseAnswer` reads it, and a code span is found by the same pattern, so the nth entry is the nth inline
 * code `AnswerText` draws.
 */
export function proseCodes(text: string): { from: number; to: number; text: string }[] {
  const out: { from: number; to: number; text: string }[] = [];
  if (!text.includes("`")) return out;
  let open = 0;
  let start = 0;
  const read = (end: number) => {
    const line = text.slice(start, end);
    const lead = line.replace(FENCE_LEAD, "");
    const ticks = /^`*/.exec(lead)![0].length;
    const rest = lead.slice(ticks);
    if (open === 0) {
      if (ticks >= 3 && !rest.includes("`")) open = ticks;
      else
        for (const m of line.matchAll(INLINE)) {
          if (m[1] === undefined) continue;
          const from = start + (m.index ?? 0) + 1;
          out.push({ from, to: from + m[1].length, text: m[1] });
        }
    } else if (ticks >= open && FENCE_BLANK.test(rest)) open = 0;
  };
  for (const m of text.matchAll(LINE_END)) {
    read(m.index ?? 0);
    start = (m.index ?? 0) + m[0].length;
  }
  read(text.length);
  return out;
}

/** `s` as a shape or group of `f`, or as `table.column` of it; null when it is neither. */
function partIn(f: PartFrame, s: string): { name: string; column: string | null } | null {
  if (f.names.has(s)) return { name: s, column: null };
  for (let i = s.indexOf("."); i >= 0; i = s.indexOf(".", i + 1)) {
    const table = s.slice(0, i);
    const column = s.slice(i + 1);
    if (f.columns.get(table)?.has(column)) return { name: table, column };
  }
  return null;
}

/** Whatever follows `Title:` when `code` starts with the frame's title and a colon. */
function afterTitle(code: string, title: string): string | null {
  if (!code.startsWith(title)) return null;
  const m = /^\s*:\s*(\S.*)$/.exec(code.slice(title.length));
  return m ? m[1] : null;
}

function resolve(code: string, frames: readonly PartFrame[]): { at: number; name: string; column: string | null } | null {
  // `Title: name` picks the frame. A title two frames share cannot pick one; then, and when the frame lacks the name,
  // the whole text is tried as a bare name (a shape may be called "Refund: Ask").
  for (let i = 0; i < frames.length; i++) {
    const rest = afterTitle(code, frames[i].title);
    if (rest === null || frames.some((f, j) => j !== i && f.title === frames[i].title)) continue;
    const part = partIn(frames[i], rest);
    if (part) return { at: i, ...part };
  }
  // A bare name links only when exactly one frame has it.
  let found: { at: number; name: string; column: string | null } | null = null;
  for (let i = 0; i < frames.length; i++) {
    const part = partIn(frames[i], code);
    if (!part) continue;
    if (found) return null;
    found = { at: i, ...part };
  }
  return found;
}

/**
 * The backticked names of `text` that are a shape, group or `table.column` of one frame (Decision 17), outside fenced
 * blocks. `Title: name` picks the frame; a bare name needs exactly one frame to have it, else it stays code.
 */
export function answerRefs(text: string, frames: readonly PartFrame[]): PartLink[] {
  const out: PartLink[] = [];
  if (frames.length === 0) return out;
  for (const c of proseCodes(text)) {
    const hit = resolve(c.text.trim(), frames);
    if (hit) out.push({ from: c.from, to: c.to, frame: frames[hit.at].title, name: hit.name, column: hit.column, at: hit.at });
  }
  return out;
}

/** The frames of a board outline (what the Ask read) as `answerRefs` reads them. */
export function outlineParts(frames: readonly { title: string; outline: Pick<FlowOutline, "nodes" | "groups"> }[]): PartFrame[] {
  return frames.map((f) => ({
    title: f.title,
    names: new Set([...f.outline.nodes.map((n) => n.name), ...f.outline.groups.map((g) => g.name)]),
    columns: new Map(f.outline.nodes.flatMap((n): [string, ReadonlySet<string>][] => (n.columns ? [[n.name, new Set(n.columns)]] : []))),
  }));
}

function groupNames(groups: readonly FlowGroup[], into: Set<string>) {
  for (const g of groups) {
    into.add(g.name);
    groupNames(g.groups, into);
  }
}

/** A parsed frame as `answerRefs` reads it: what the canvas holds now. */
export function docParts(title: string, doc: Pick<FlowDoc, "nodes" | "groups"> | null): PartFrame {
  const names = new Set<string>();
  const columns = new Map<string, ReadonlySet<string>>();
  if (doc) {
    for (const n of doc.nodes) {
      names.add(n.name);
      if (n.rows) columns.set(n.name, new Set(n.rows.map((r) => splitRow(r).name)));
    }
    groupNames(doc.groups, names);
  }
  return { title, names, columns };
}

/** The ring entry for a column: apart from any shape's name, since a shape's name may hold a dot. */
export const columnRing = (table: string, column: string) => `${table}\u0000${column}`;

/** The table and column a ring entry names, or null for a shape's name. */
export function ringColumn(entry: string): { table: string; column: string } | null {
  const at = entry.indexOf("\u0000");
  return at < 0 ? null : { table: entry.slice(0, at), column: entry.slice(at + 1) };
}

/** The links as the canvas rings them: by the frame's layout key (`keyOf` its place), each name or column once. */
export function ringParts(links: readonly PartLink[], keyOf: (at: number) => string | undefined): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of links) {
    const key = keyOf(l.at);
    if (key === undefined) continue;
    let set = out.get(key);
    if (!set) out.set(key, (set = new Set()));
    set.add(l.column === null ? l.name : columnRing(l.name, l.column));
  }
  return out;
}
