// Diagram step 10 (F28, board DiagramStartWell): converted Mermaid inserted into the open diagram (draw.io's Arrange >
// Insert > Mermaid), and a Mermaid paste into a .flow file. The diagram must be the same kind. Every name the open
// diagram already has comes in free (`Ship order 2`, the paste rule); a sequence reuses its participants by name; a mind
// map's central idea comes in as a topic under the open map's. Runs in the language worker against the cached parse.
import type { TextEdit } from "../protocol";
import { ER_NOTES, erRenameNote, lineBreak, lineStart, nextLine, renameNode } from "./edits";
import { type DiagramKind, isStateMarker, sqlFreeName } from "./model";
import { type FlowParse, parseFlow } from "./parse";
import { article } from "../../format/article";

/** The kind as Insert's reason says it. */
export const KIND_SHORT: Record<DiagramKind, string> = {
  dfd: "data flow",
  flow: "flowchart",
  cloud: "cloud diagram",
  er: "ER diagram",
  sequence: "sequence",
  state: "state diagram",
  class: "class diagram",
  mindmap: "mind map",
  timeline: "timeline",
};

/** Why Insert refuses another kind (board DiagramStartWell). */
export const insertKindRefusal = (here: DiagramKind, that: DiagramKind) =>
  `Insert takes ${article(KIND_SHORT[here])} here; this is ${article(KIND_SHORT[that])}. Create makes it a new diagram.`;

/** Applies sorted, non-overlapping edits to `text`. */
function applyEdits(text: string, edits: readonly TextEdit[]): string {
  let out = text;
  for (const e of [...edits].sort((a, b) => b.from - a.from)) out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  return out;
}

export type InsertResult = { edits: TextEdit[]; names: Record<string, string>; note?: string };

/** `name` when it is free, else the next free `base N` (the paste rule). */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  const m = / (\d+)$/.exec(name);
  const base = m ? name.slice(0, m.index) : name;
  for (let n = m ? Number(m[1]) + 1 : 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

const isMarker = (n: string) => isStateMarker(n);

/**
 * The edits that write `flow` (a whole .flow file) into `text`: at the end, after a blank line, or at `at` (the start of
 * a line, where a paste in the text goes). `names` maps each shape that came in to the name it has now.
 */
export function insertFlow(text: string, parse: FlowParse, flow: string, at?: number): InsertResult {
  const refuse = (note: string): InsertResult => ({ edits: [], names: {}, note });
  const kind = parse.kind;
  let src = flow;
  let p = parseFlow(src);
  if (!kind) return refuse("Fix the diagram's first line first, so nothing was inserted.");
  if (parse.oldEr) return refuse(ER_NOTES.oldForm);
  if (p.oldEr) return refuse(ER_NOTES.oldIncoming);
  if (!p.kind || !p.doc) return refuse("The Mermaid did not convert, so nothing was inserted.");
  if (p.kind !== kind) return refuse(insertKindRefusal(kind, p.kind));
  const here = new Set(parse.defined.keys());
  // A new name is free of the open diagram's names and of every name coming in, so no rename meets another.
  const taken = new Set([...here, ...p.defined.keys()]);
  const names: Record<string, string> = Object.create(null);
  const renames: [string, string][] = [];
  let reused = 0;
  const shapes = p.doc.nodes.filter((n) => n.kind !== "note" && !isMarker(n.name)).map((n) => n.name);
  const groups: string[] = [];
  for (const g of p.defined.keys()) if (p.span(`group:${g}`)) groups.push(g);
  // A sequence's participant the open diagram has is the same one: its line goes, its messages stay.
  for (const name of shapes) {
    if (kind === "sequence" && here.has(name)) {
      reused++;
      const sp = p.span(`node:${name}`);
      if (sp && /^\s*(participant|actor)\b/.test(src.slice(lineStart(src, sp.from)))) {
        src = applyEdits(src, [{ from: lineStart(src, sp.from), to: nextLine(src, sp.from), insert: "" }]);
        p = parseFlow(src);
      }
      continue;
    }
    // An ER table comes in with a plain SQL name (orders_2), as a paste names it.
    const next = here.has(name) ? (kind === "er" ? sqlFreeName(name, taken) : freeName(name, taken)) : name;
    taken.add(next);
    names[name] = next;
    if (next !== name) renames.push([name, next]);
  }
  for (const g of groups) {
    if (!here.has(g)) continue;
    const next = freeName(g, taken);
    taken.add(next);
    renames.push([g, next]);
  }
  // One at a time, each from the text the one before left, so every line that names it follows.
  for (const [from, to] of renames) {
    const edits = renameNode(src, p, from, to);
    // renameNode checks erRenameNote itself; it is asked again only to say why.
    if (edits.length === 0) return refuse(erRenameNote(src, p, from, to) ?? `${from} could not be renamed ${to}, so nothing was inserted.`);
    src = applyEdits(src, edits);
    p = parseFlow(src);
  }
  // The body: everything after the `diagram` line, its leading blank lines left out.
  let body = src.slice(nextLine(src, 0)).replace(/^(\s*\n)+/, "");
  if (kind === "mindmap") {
    // The central idea is a topic under the open map's; everything under it goes a level deeper.
    body = body
      .split("\n")
      .map((l) => (/^root\s/.test(l) ? `  ${l.replace(/^root\s+/, "")}` : /^\s+\S/.test(l) ? `  ${l}` : l))
      .join("\n");
  }
  const nl = lineBreak(text);
  if (nl !== "\n") body = body.replace(/\r?\n/g, nl);
  if (!body.trim()) return refuse("The Mermaid has nothing to insert.");
  let edit: TextEdit;
  if (at !== undefined) {
    edit = { from: at, to: at, insert: body };
  } else {
    const end = text.length;
    const lead = text === "" || text.endsWith(`${nl}${nl}`) ? "" : text.endsWith(nl) ? (kind === "mindmap" ? "" : nl) : nl + (kind === "mindmap" ? "" : nl);
    edit = { from: end, to: end, insert: lead + body };
  }
  const note = reused ? `${reused.toLocaleString("en-US")} ${reused === 1 ? "participant already here is" : "participants already here are"} reused.` : undefined;
  return { edits: [edit], names: { ...names }, ...(note ? { note } : {}) };
}
