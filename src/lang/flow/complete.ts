// Completion for .flow (spec section 2, "Editor"): kinds and attribute keys inside brackets, icon names after
// `icon:` (provider prefix first), node names where a name goes, and the diagram kinds on the first line.
import { rankIcons } from "./iconRank";
import { ATTR_KEYS, COLUMN_FLAGS, DIAGRAM_KINDS, type DiagramKind, flowName, KINDS, NOTE_KINDS } from "./model";
import { parseFlow } from "./parse";

export type FlowCompletion = {
  label: string;
  kind: "kind" | "attr" | "node" | "icon" | "keyword";
  /** The text that replaces `from..pos`. */
  apply: string;
};

/** Items to offer at `pos`, best first; `from` is where the word being completed starts. */
export type FlowCompletionResult = { from: number; items: FlowCompletion[] };

export { rankIcons };

const KIND_LINE = new RegExp(`^diagram\\s+(${DIAGRAM_KINDS.join("|")})(?=$|[\\s"]|//)`);

/** The kind on the first statement line, read without a full parse. */
function diagramKind(text: string): DiagramKind | null {
  let p = 0;
  while (p < text.length) {
    const e = text.indexOf("\n", p);
    const line = text.slice(p, e < 0 ? text.length : e).trim();
    if (line !== "" && !line.startsWith("//")) {
      const m = KIND_LINE.exec(line);
      return m ? (m[1] as DiagramKind) : null;
    }
    if (e < 0) break;
    p = e + 1;
  }
  return null;
}

/** True when only blank lines and comments come before `lineStart`. */
function firstStatement(text: string, lineStart: number): boolean {
  let p = 0;
  while (p < lineStart) {
    const e = text.indexOf("\n", p);
    const end = e < 0 || e > lineStart ? lineStart : e;
    const line = text.slice(p, end).trim();
    if (line !== "" && !line.startsWith("//")) return false;
    if (e < 0) break;
    p = e + 1;
  }
  return true;
}

/** The words that start a statement in the kinds written with them. */
const LEADING_WORDS: Partial<Record<DiagramKind, string[]>> = {
  sequence: ["participant", "actor", "activate", "deactivate", "loop", "alt", "opt"],
  class: ["class", "interface", "enum"],
  mindmap: ["root"],
  timeline: ["section", "milestone"],
};

const startsWithCi = (label: string, typed: string) => label.toLowerCase().startsWith(typed.toLowerCase());

/** What the line holds up to `pos`, read as the parser reads it. */
type Context =
  | { at: "none" }
  | { at: "bracket"; item: string; itemFrom: number; items: string[] }
  | { at: "name"; typed: string; from: number };

function context(line: string, lineFrom: number): Context {
  let inQuote = false;
  let quoteFrom = -1;
  let inBracket = false;
  let itemFrom = 0;
  const items: string[] = [];
  let nameFrom = 0;
  let closedSomething = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuote) {
      if (c === "\\") i++;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      quoteFrom = i;
      continue;
    }
    if (c === "/" && line[i + 1] === "/") return { at: "none" };
    if (inBracket) {
      if (c === ",") {
        items.push(line.slice(itemFrom, i).trim());
        itemFrom = i + 1;
      } else if (c === "]") {
        inBracket = false;
        closedSomething = true;
      }
      continue;
    }
    if (c === "[") {
      inBracket = true;
      itemFrom = i + 1;
      items.length = 0;
    } else if (c === ":" || c === "{" || c === "}") {
      // A label runs to the end of the line; nothing is completed after a brace.
      return { at: "none" };
    } else if (c === ">") {
      nameFrom = i + 1;
      closedSomething = false;
    } else if (c === "-" && (i === 0 || /\s/.test(line[i - 1])) && (i + 1 >= line.length || /\s/.test(line[i + 1]))) {
      nameFrom = i + 1;
      closedSomething = false;
    } else if (/\s/.test(c)) {
      // After a step 12 arrow (--, 1--*, <|--, *--): the name after it is being typed.
      let t = i;
      while (t > 0 && !/\s/.test(line[t - 1])) t--;
      const token = line.slice(t, i);
      if (token && /^[-<>|.*1]+$/.test(token) && /[-]/.test(token) && token.length > 1) {
        nameFrom = i + 1;
        closedSomething = false;
      }
    }
  }
  if (inBracket) {
    if (inQuote) return { at: "none" };
    return { at: "bracket", item: line.slice(itemFrom), itemFrom: lineFrom + itemFrom, items };
  }
  if (closedSomething) return { at: "none" };
  let from = nameFrom;
  while (from < line.length && /\s/.test(line[from])) from++;
  if (inQuote && quoteFrom !== from) return { at: "none" };
  return { at: "name", typed: line.slice(from), from: lineFrom + from };
}

/**
 * Completion at `pos`. `defined` maps each node and group name, in order, to its 1-based line: the parse's
 * `defined` for this same text (the worker passes its cached one); when not given the text is parsed here.
 * A name defined on the line being typed is the word being typed, so it is left out.
 */
export function completeFlow(
  text: string,
  pos: number,
  iconNames: readonly string[],
  defined?: ReadonlyMap<string, number>,
): FlowCompletionResult {
  const lineFrom = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineFrom, pos);
  const none = { from: pos, items: [] };

  const header = /^(\s*diagram\s+)(\w*)$/.exec(line);
  if (header && firstStatement(text, lineFrom)) {
    const typed = header[2];
    const items = DIAGRAM_KINDS.filter((k) => k.startsWith(typed)).map((k) => ({ label: k, kind: "keyword" as const, apply: k }));
    return { from: pos - typed.length, items };
  }

  const ctx = context(line, lineFrom);
  if (ctx.at === "none") return none;

  if (ctx.at === "bracket") {
    const colon = ctx.item.indexOf(":");
    if (colon >= 0) {
      const key = ctx.item.slice(0, colon).trim();
      if (key !== "icon") return none;
      const typed = ctx.item.slice(colon + 1).trimStart();
      return { from: pos - typed.length, items: rankIcons(iconNames, typed).map((i) => ({ label: i, kind: "icon" as const, apply: i })) };
    }
    const typed = ctx.item.trimStart();
    const used = new Set(ctx.items.map((i) => (i.includes(":") ? i.slice(0, i.indexOf(":")).trim() : i)));
    const dk = diagramKind(text);
    // An ER column line (`customers.id int [`) takes its flags (ER build A).
    if (dk === "er" && /^\s*[^\s."[]+\.\S/.test(line.slice(0, line.lastIndexOf("[")))) {
      const taken = new Set(ctx.items.map((i) => i.toLowerCase().split(/\s+/).join(" ")));
      const flags = COLUMN_FLAGS.filter((f) => !taken.has(f) && startsWithCi(f, typed));
      return { from: pos - typed.length, items: flags.map((f) => ({ label: f, kind: "keyword" as const, apply: f })) };
    }
    const hasKind = ctx.items.some((i) => i !== "" && !i.includes(":"));
    const kinds = dk === "cloud" || hasKind ? [] : dk ? KINDS[dk] : [...KINDS.dfd, ...KINDS.flow];
    // A cloud node is drawn by its icon, so the icon key comes first there.
    const keys = dk === "cloud" ? ["icon", ...ATTR_KEYS.filter((k) => k !== "icon")] : [...ATTR_KEYS];
    const items: FlowCompletion[] = [
      ...kinds.map((k) => ({ label: k, kind: "kind" as const, apply: k })),
      ...keys.filter((k) => !used.has(k)).map((k) => ({ label: k, kind: "attr" as const, apply: `${k}: ` })),
    ];
    return { from: pos - typed.length, items: items.filter((i) => startsWithCi(i.label, typed)) };
  }

  const typed = ctx.typed.startsWith('"') ? ctx.typed.slice(1) : ctx.typed;
  // Step 12: at the start of a line, the words a kind starts its statements with.
  const dk = diagramKind(text);
  const startOfLine = line.slice(0, ctx.from - lineFrom).trim() === "";
  const words = startOfLine && dk ? [...(LEADING_WORDS[dk] ?? []), ...(NOTE_KINDS.has(dk) ? ["note"] : [])] : [];
  const lead: FlowCompletion[] = words
    .filter((w) => startsWithCi(w, typed) && w !== typed)
    .map((w) => ({ label: w, kind: "keyword" as const, apply: w === "note" ? "note: " : `${w} ` }));
  const names = defined ?? parseFlow(text).defined;
  let lineNo = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < lineFrom; i = text.indexOf("\n", i + 1)) lineNo++;
  const items: FlowCompletion[] = [...lead];
  for (const [n, at] of names) {
    if (at !== lineNo && startsWithCi(n, typed)) items.push({ label: n, kind: "node", apply: flowName(n) });
  }
  return { from: ctx.from, items };
}
