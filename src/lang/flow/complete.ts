// Completion for .flow (spec section 2, "Editor"): kinds and attribute keys inside brackets, icon names after
// `icon:` (provider prefix first), node names where a name goes, and the diagram kinds on the first line.
import { rankIcons } from "./iconRank";
import { CSS_COLOURS } from "./colours";
import { ATTR_DIAGRAMS, ATTR_KEYS, COLUMN_FLAGS, DIAGRAM_KINDS, type DiagramKind, flowName, KINDS, LINE_COLOUR_DIAGRAMS, NOTE_KINDS, PALETTE } from "./model";
import { parseFlow } from "./parse";

export type FlowCompletion = {
  label: string;
  kind: "kind" | "attr" | "node" | "icon" | "keyword";
  /** The text that replaces `from..pos`. */
  apply: string;
  /** Quiet words beside the label: what a key or colour is for, the words a shape shows (step 11). */
  detail?: string;
};

/** Items to offer at `pos`, best first; `from` is where the word being completed starts. */
export type FlowCompletionResult = { from: number; items: FlowCompletion[] };

export { rankIcons };

/** The diagram kinds that start with `typed`, as completion items. */
export function kindItems(typed: string): FlowCompletion[] {
  return DIAGRAM_KINDS.filter((k) => k.startsWith(typed)).map((k) => ({ label: k, kind: "keyword" as const, apply: k }));
}

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

/** Step 11: what each palette colour means (board DiagramColourLabels), shown beside it. */
export const COLOUR_MEANING: Record<(typeof PALETTE)[number], string> = {
  accent: "Accent: the main path",
  info: "Info: a reference",
  success: "Success: done or OK",
  warning: "Warning: needs a look",
  danger: "Danger: failure, error, data at risk",
  muted: "Muted: out of scope, later, legacy",
};

const KEY_DETAIL: Partial<Record<string, string>> = {
  label: "the words it shows, when another shape has the name",
  color: "a preset, a CSS colour name or a hex",
};

/**
 * The block the line at `lineFrom` is written in, read by walking the lines before it to the innermost open `{`
 * (quotes and comments skipped): a table, a group (its line starts with the word), or null at the top.
 */
function openBlock(text: string, lineFrom: number): "table" | "group" | null {
  const open: number[] = [];
  let lineStart = 0;
  let inQuote = false;
  for (let i = 0; i < lineFrom; i++) {
    const c = text[i];
    if (c === "\n") {
      inQuote = false;
      lineStart = i + 1;
    } else if (inQuote) {
      if (c === "\\") i++;
      else if (c === '"') inQuote = false;
    } else if (c === '"') inQuote = true;
    else if (c === "/" && text[i + 1] === "/") {
      const e = text.indexOf("\n", i);
      if (e < 0 || e >= lineFrom) break;
      i = e - 1;
    } else if (c === "{") open.push(lineStart);
    else if (c === "}") open.pop();
  }
  if (open.length === 0) return null;
  return /^\s*group\b/.test(text.slice(open[open.length - 1], lineFrom)) ? "group" : "table";
}

/** The words of a column line up to the position, with the word being typed (a quote or a comment ends the offer). */
function columnWords(line: string): { done: string[]; typed: string } | null {
  const done: string[] = [];
  let start = -1;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "/" && line[i + 1] === "/") return null;
    if (c === '"') {
      const close = line.indexOf('"', i + 1);
      if (close < 0) return null;
      if (start < 0) start = i;
      i = close;
    } else if (c === "(") {
      depth++;
      if (start < 0) start = i;
    } else if (c === ")") depth = Math.max(0, depth - 1);
    else if (/\s/.test(c) && depth === 0) {
      if (start >= 0) done.push(line.slice(start, i));
      start = -1;
    } else if (start < 0) start = i;
  }
  return { done, typed: start >= 0 ? line.slice(start) : "" };
}

/** The flags a column line has not yet written, offered once its type (or a first flag) is there. */
function flagItems(line: string): { typed: string; items: FlowCompletion[] } | null {
  const words = columnWords(line);
  if (!words) return null;
  const { done, typed } = words;
  if (typed.startsWith('"') || done.length < 2) return null;
  const lower = done.map((w) => w.toLowerCase());
  const isFlag = (w: string) => w === "pk" || w === "unique" || w === "not";
  // The type is the word after the name unless that word is a flag already.
  const flagsFrom = isFlag(lower[1]) ? 1 : 2;
  const have = new Set<string>();
  for (let i = flagsFrom; i < lower.length; i++) {
    if (lower[i] === "not" && lower[i + 1] === "null") {
      have.add("not null");
      i++;
    } else have.add(lower[i]);
  }
  if (lower[lower.length - 1] === "not" && lower.length > flagsFrom) {
    return { typed, items: startsWithCi("null", typed) ? [{ label: "null", kind: "keyword", apply: "null" }] : [] };
  }
  const items = COLUMN_FLAGS.filter((f) => !have.has(f) && startsWithCi(f, typed)).map((f) => ({ label: f, kind: "keyword" as const, apply: f }));
  return { typed, items };
}

/** The columns after `table.`: the table is the longest part before a dot that names a table (at most four dots). */
function columnItems(typed: string, columnsOf: (table: string) => readonly string[] | null): { rest: string; items: FlowCompletion[] } | null {
  if (typed.startsWith('"')) return null;
  let dot = typed.lastIndexOf(".");
  for (let n = 0; dot > 0 && n < 4; n++, dot = typed.lastIndexOf(".", dot - 1)) {
    const columns = columnsOf(typed.slice(0, dot));
    if (columns === null) continue;
    const rest = typed.slice(dot + 1);
    return { rest, items: columns.filter((c) => startsWithCi(c, rest)).map((c) => ({ label: c, kind: "node" as const, apply: c })) };
  }
  return null;
}

/** What the line holds up to `pos`, read as the parser reads it. */
type Context =
  | { at: "none" }
  | { at: "bracket"; item: string; itemFrom: number; items: string[]; line: boolean }
  | { at: "name"; typed: string; from: number };

function context(line: string, lineFrom: number): Context {
  let inQuote = false;
  let quoteFrom = -1;
  let inBracket = false;
  let itemFrom = 0;
  const items: string[] = [];
  let nameFrom = 0;
  let closedSomething = false;
  /** An arrow came before the bracket: a line's attributes. */
  let arrowSeen = false;
  let lineBracket = false;
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
      lineBracket = arrowSeen;
      itemFrom = i + 1;
      items.length = 0;
    } else if (c === ":" && arrowSeen) {
      // A line's label runs to the end of the line, but an open [ at its end is its attributes (step 11).
      const open = line.lastIndexOf("[");
      if (open > i && !line.includes("]", open)) {
        const inner = line.slice(open + 1);
        const parts = inner.split(",");
        const item = parts.pop() ?? "";
        return { at: "bracket", item, itemFrom: lineFrom + open + 1 + inner.length - item.length, items: parts.map((p) => p.trim()), line: true };
      }
      return { at: "none" };
    } else if (c === ":" || c === "{" || c === "}") {
      // A label runs to the end of the line; nothing is completed after a brace.
      return { at: "none" };
    } else if (c === ">") {
      nameFrom = i + 1;
      closedSomething = false;
      arrowSeen = true;
    } else if (c === "-" && (i === 0 || /\s/.test(line[i - 1])) && (i + 1 >= line.length || /\s/.test(line[i + 1]))) {
      nameFrom = i + 1;
      closedSomething = false;
      arrowSeen = true;
    } else if (/\s/.test(c)) {
      // After a step 12 arrow (--, 1--*, <|--, *--): the name after it is being typed.
      let t = i;
      while (t > 0 && !/\s/.test(line[t - 1])) t--;
      const token = line.slice(t, i);
      if (token && /^[-<>|.*1]+$/.test(token) && /[-]/.test(token) && token.length > 1) {
        nameFrom = i + 1;
        closedSomething = false;
        arrowSeen = true;
      }
    }
  }
  if (inBracket) {
    if (inQuote) return { at: "none" };
    return { at: "bracket", item: line.slice(itemFrom), itemFrom: lineFrom + itemFrom, items, line: lineBracket };
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
  /** Step 11: each shape's `label:` by its name (the parse's `labels`), shown beside its name. */
  labels?: ReadonlyMap<string, string>,
  /** ER: the column names of a table by its name (null when there is no such table). */
  columnsOf?: (table: string) => readonly string[] | null,
  /** The parse's `oldEr`: an old-form ER frame offers nothing ER-specific. Read from a parse here when not given. */
  oldEr?: boolean,
): FlowCompletionResult {
  const lineFrom = text.lastIndexOf("\n", pos - 1) + 1;
  const line = text.slice(lineFrom, pos);
  const none = { from: pos, items: [] };

  const header = /^(\s*diagram\s+)(\w*)$/.exec(line);
  if (header && firstStatement(text, lineFrom)) {
    const typed = header[2];
    return { from: pos - typed.length, items: kindItems(typed) };
  }

  // ER (table blocks): what is offered depends on the block the line is in.
  const dk = diagramKind(text);
  let erBlock: ReturnType<typeof openBlock> | undefined;
  let parsed: ReturnType<typeof parseFlow> | null = null;
  if (dk === "er") {
    if (oldEr === undefined) {
      parsed = defined ? null : parseFlow(text);
      oldEr = parsed?.oldEr ?? false;
    }
    if (!oldEr) {
      erBlock = openBlock(text, lineFrom);
      if (erBlock === "table") {
        const flags = flagItems(line);
        return flags ? { from: pos - flags.typed.length, items: flags.items } : none;
      }
    }
  }

  const ctx = context(line, lineFrom);
  if (ctx.at === "none") return none;

  if (ctx.at === "bracket") {
    const colon = ctx.item.indexOf(":");
    if (colon >= 0) {
      const key = ctx.item.slice(0, colon).trim();
      const typed = ctx.item.slice(colon + 1).trimStart();
      if (key === "color") {
        const presets = PALETTE.filter((c) => startsWithCi(c, typed)).map((c) => ({ label: c, kind: "keyword" as const, apply: c, detail: COLOUR_MEANING[c] }));
        const names = [...CSS_COLOURS].filter(([c]) => startsWithCi(c, typed)).map(([c, hex]) => ({ label: c, kind: "keyword" as const, apply: c, detail: hex }));
        return { from: pos - typed.length, items: [...presets, ...names] };
      }
      if (key !== "icon" || ctx.line) return none;
      return { from: pos - typed.length, items: rankIcons(iconNames, typed).map((i) => ({ label: i, kind: "icon" as const, apply: i })) };
    }
    const typed = ctx.item.trimStart();
    const used = new Set(ctx.items.map((i) => (i.includes(":") ? i.slice(0, i.indexOf(":")).trim() : i)));
    const hasKind = ctx.items.some((i) => i !== "" && !i.includes(":"));
    if (erBlock !== undefined && !ctx.line) {
      // A table takes a kind, an icon, a label and a colour; a group an icon and a colour.
      const group = /^\s*group\b/.test(line);
      const erKeys = (group ? ["icon", "color"] : ["icon", "label", "color"]).filter((k) => !used.has(k));
      const erKinds = group || hasKind ? [] : KINDS.er;
      const erItems: FlowCompletion[] = [
        ...erKinds.map((k) => ({ label: k, kind: "kind" as const, apply: k })),
        ...erKeys.map((k) => ({ label: k, kind: "attr" as const, apply: `${k}: `, ...(KEY_DETAIL[k] ? { detail: KEY_DETAIL[k] } : {}) })),
      ];
      return { from: pos - typed.length, items: erItems.filter((i) => startsWithCi(i.label, typed)) };
    }
    const kinds = ctx.line || dk === "cloud" || dk === "sequence" || hasKind ? [] : dk ? KINDS[dk] : [...KINDS.dfd, ...KINDS.flow];
    // A cloud node is drawn by its icon, so the icon key comes first there. A line takes only a colour; the kinds
    // written with a word or a date take no label or colour (step 11).
    const all = dk === "cloud" ? ["icon", ...ATTR_KEYS.filter((k) => k !== "icon")] : dk === "sequence" ? (/^\s*(participant|actor)\s/.test(line) ? ["icon", "label", "color"] : []) : [...ATTR_KEYS];
    const keys = ctx.line ? (!dk || LINE_COLOUR_DIAGRAMS.has(dk) ? ["color"] : []) : all.filter((k) => !dk || ATTR_DIAGRAMS.has(dk) || (k !== "label" && k !== "color"));
    const items: FlowCompletion[] = [
      ...kinds.map((k) => ({ label: k, kind: "kind" as const, apply: k })),
      ...keys.filter((k) => !used.has(k)).map((k) => ({ label: k, kind: "attr" as const, apply: `${k}: `, ...(KEY_DETAIL[k] ? { detail: KEY_DETAIL[k] } : {}) })),
    ];
    return { from: pos - typed.length, items: items.filter((i) => startsWithCi(i.label, typed)) };
  }

  const typed = ctx.typed.startsWith('"') ? ctx.typed.slice(1) : ctx.typed;
  // Step 12: at the start of a line, the words a kind starts its statements with.
  const startOfLine = line.slice(0, ctx.from - lineFrom).trim() === "";
  if (erBlock !== undefined && columnsOf) {
    const cols = columnItems(typed, columnsOf);
    if (cols) return { from: pos - cols.rest.length, items: cols.items };
  }
  const words = startOfLine && dk ? [...(erBlock !== undefined ? ["group"] : []), ...(LEADING_WORDS[dk] ?? []), ...(NOTE_KINDS.has(dk) ? ["note"] : [])] : [];
  const lead: FlowCompletion[] = words
    .filter((w) => startsWithCi(w, typed) && w !== typed)
    .map((w) => ({ label: w, kind: "keyword" as const, apply: w === "note" ? "note: " : `${w} ` }));
  parsed ??= defined ? null : parseFlow(text);
  const names = defined ?? parsed!.defined;
  const shows = labels ?? parsed?.labels;
  let lineNo = 1;
  for (let i = text.indexOf("\n"); i >= 0 && i < lineFrom; i = text.indexOf("\n", i + 1)) lineNo++;
  const items: FlowCompletion[] = [...lead];
  for (const [n, at] of names) {
    if (at === lineNo) continue;
    const label = shows?.get(n);
    if (startsWithCi(n, typed) || (label !== undefined && startsWithCi(label, typed))) {
      items.push({ label: n, kind: "node", apply: flowName(n), ...(label !== undefined ? { detail: `shows "${label.replace(/\r?\n/g, " ")}" (label:)` } : {}) });
    }
  }
  return { from: ctx.from, items };
}
