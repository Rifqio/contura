// Mermaid flowchart to .flow: Contura's own small converter (spec, "Mermaid to .flow mapping"), run in the
// language worker. One way: the Mermaid text is not kept. A line it cannot read is left out and named.
import { type DiagramKind, MAX_FLOW_NODES, MAX_FLOW_TEXT } from "../lang/flow/model";
import { parseFlow } from "../lang/flow/parse";
import { ER_REFUSED, headOf, isMermaid, kindWord, MERMAID_KINDS } from "./mermaidHead";
import { classToFlow, type KindContext, type KindOut, mindmapToFlow, sequenceToFlow, stateToFlow, timelineToFlow } from "./mermaidKinds";
import { type FlowDoc, type FlowGroup, type FlowKind, type FlowLink, type FlowNode, needsQuotes, writeFlow } from "./flowModel";

export { ER_REFUSED, isMermaid };

export type MermaidNote = { line: number; text: string };

export type MermaidResult = {
  /** The Contura kind it became (step 10); "flow" for a flowchart, and for a refused text. */
  kind: DiagramKind;
  /** What came in, by kind: "Sequence: 3 participants, 5 messages". Empty when nothing did. */
  count: string;
  flow: string;
  doc: FlowDoc;
  direction: "TB" | "LR";
  notes: MermaidNote[];
  errors: MermaidNote[];
  nodes: number;
  links: number;
};

// The same limits a canvas paste keeps (one place for both).
export const MAX_MERMAID_CHARS = MAX_FLOW_TEXT;
export { MAX_FLOW_NODES };
/** Links past this stop the work, so the preview stays light: `a1 & ... & a1000 --> b1 & ...` alone would make a million. */
export const MAX_FLOW_LINKS = 3000;
/** Subgraphs nest at most this deep, and a chart has at most this many; the writer and the preview recurse no deeper. */
export const MAX_GROUP_DEPTH = 20;
export const MAX_GROUPS = 500;

const NODE_LIMIT = "This flowchart has more than 2,000 nodes";
const LINK_LIMIT = "This flowchart has more than 3,000 links";
const DEPTH_LIMIT = "This flowchart nests groups more than 20 deep";
const GROUP_LIMIT = "This flowchart has more than 500 groups";

/** Thrown out of the parse the moment a limit is passed, so the rest of the text is never read. */
class LimitPassed extends Error {}

/** First words of the other Mermaid diagram types, refused by name. */
const OTHER_DIAGRAM =
  /(Diagram(-v2)?|-beta)$|^(gantt|pie|mindmap|journey|gitGraph|timeline|quadrantChart|C4\w*|sankey|xychart|block|packet|kanban|architecture|zenuml|treemap|radar)$/;

/** A key the object itself has, never one from Object's prototype (`constructor`, `toString`). */
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

const LINK_HELP = "Mermaid links are -->, ---, -.-> or ==>.";

/** What a Mermaid shape becomes. `round` is start or end by its links, else a step. */
type Shape =
  | { kind: "step" | "decision" | "io" | "subprocess" }
  | { kind: "round"; what: string }
  | { kind: "database" }
  | { kind: "foreign"; what: string };

const SHAPES: { open: string; close: string[]; shape: Shape | ((close: string) => Shape); tight?: boolean }[] = [
  { open: "(((", close: [")))"], shape: { kind: "round", what: "double circle ((( )))" } },
  { open: "([", close: ["])"], shape: { kind: "round", what: "stadium ([ ])" } },
  { open: "((", close: ["))"], shape: { kind: "round", what: "circle (( ))" } },
  { open: "[[", close: ["]]"], shape: { kind: "subprocess" } },
  { open: "[(", close: [")]"], shape: { kind: "database" } },
  { open: "[/", close: ["/]", "\\]"], shape: (c) => (c === "/]" ? { kind: "io" } : { kind: "foreign", what: "trapezoid [/ \\]" }) },
  { open: "[\\", close: ["\\]", "/]"], shape: (c) => (c === "\\]" ? { kind: "io" } : { kind: "foreign", what: "trapezoid [\\ /]" }) },
  { open: "{{", close: ["}}"], shape: { kind: "foreign", what: "hexagon {{ }}" } },
  { open: "[", close: ["]"], shape: { kind: "step" } },
  { open: "(", close: [")"], shape: { kind: "step" } },
  { open: "{", close: ["}"], shape: { kind: "decision" } },
  { open: ">", close: ["]"], shape: { kind: "foreign", what: "flag > ]" }, tight: true },
];

const HEXAGON: Shape = { kind: "foreign", what: "hexagon {{ }}" };

/** Mermaid's `@{ shape: ... }` names, by what they become. */
const SHAPE_NAMES: Record<string, Shape> = {
  ...Object.fromEntries(["rect", "rectangle", "proc", "process", "rounded", "event"].map((n) => [n, { kind: "step" }])),
  ...Object.fromEntries(["diamond", "diam", "decision", "question"].map((n) => [n, { kind: "decision" }])),
  ...Object.fromEntries(["lean-r", "lean-right", "in-out", "lean-l", "lean-left", "out-in"].map((n) => [n, { kind: "io" }])),
  ...Object.fromEntries(["subproc", "subprocess", "subroutine", "fr-rect", "framed-rectangle"].map((n) => [n, { kind: "subprocess" }])),
  ...Object.fromEntries(["cyl", "cylinder", "database", "db"].map((n) => [n, { kind: "database" }])),
  ...Object.fromEntries(["stadium", "pill", "terminal"].map((n) => [n, { kind: "round", what: "stadium ([ ])" }])),
  ...Object.fromEntries(
    ["circle", "circ", "sm-circ", "small-circle", "start", "fr-circ", "framed-circle", "stop"].map((n) => [n, { kind: "round", what: "circle (( ))" }]),
  ),
  ...Object.fromEntries(["dbl-circ", "double-circle"].map((n) => [n, { kind: "round", what: "double circle ((( )))" }])),
  ...Object.fromEntries(["hex", "hexagon", "prepare"].map((n) => [n, HEXAGON])),
  ...Object.fromEntries(["trap-b", "trapezoid", "priority", "trapezoid-bottom"].map((n) => [n, { kind: "foreign", what: "trapezoid [/ \\]" }])),
  ...Object.fromEntries(["trap-t", "inv-trapezoid", "manual", "trapezoid-top"].map((n) => [n, { kind: "foreign", what: "trapezoid [\\ /]" }])),
  odd: { kind: "foreign", what: "flag > ]" },
} as Record<string, Shape>;

/** One mention of a node in a statement, with what that mention defines. */
type Mention = { id: string; label?: string; labelNotes: string[]; shape?: Shape; unknownShape?: string; classes: string[] };
type RawLink = { from: string; to: string; arrow: FlowLink["arrow"]; label?: string; chained: boolean };
type Parsed = { ok: true; mentions: Mention[]; links: RawLink[]; notes: string[] } | { ok: false; error: string };

const ENTITIES: Record<string, string> = { quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };

/** A label as .flow keeps it: entities read, `<br>` a space, markdown markup gone; each change noted. */
function cleanLabel(raw: string): { text: string; notes: ((name: string) => string)[] } {
  const notes: ((name: string) => string)[] = [];
  let text = raw.replace(/#(\w+);/g, (m, e: string) => (/^\d+$/.test(e) ? String.fromCodePoint(Number(e)) : (own(ENTITIES, e) ? ENTITIES[e] : m)));
  if (/<br\s*\/?>/i.test(text)) {
    text = text.replace(/\s*<br\s*\/?>\s*/gi, " ");
    notes.push((name) => `<br> in ${name} became a space.`);
  }
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
    text = text
      .slice(1, -1)
      .replace(/(\*\*|__)(.+?)\1/g, "$2")
      .replace(/(\*|_)(.+?)\1/g, "$2")
      .replace(/\s*\n\s*/g, " ");
    notes.push((name) => `the markdown in ${name} is left out.`);
  }
  return { text: text.replace(/\s+/g, " ").trim(), notes };
}

const unquote = (s: string) => {
  const t = s.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
};

/** Splits on `;` outside quotes and brackets. */
function splitStatements(line: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === "[" || c === "(" || c === "{") depth++;
    else if ((c === "]" || c === ")" || c === "}") && depth > 0) depth--;
    else if (c === ";" && depth === 0) {
      out.push(line.slice(start, i));
      start = i + 1;
    }
  }
  out.push(line.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

const ID = /^[\p{L}\p{N}_]+/u;

type LinkToken = { arrow: FlowLink["arrow"]; label?: string; note?: string; hidden?: boolean };

/** Reads a statement: nodes joined by `&`, and links between them, possibly chained. */
function parseStatement(s: string, linksBefore: number): Parsed {
  let pos = 0;
  let unclosed: string | null = null;
  const ws = () => {
    while (pos < s.length && /\s/.test(s[pos])) pos++;
  };

  function readLabel(closes: string[]): { label: string; close: string } | null {
    if (s[pos] === '"') {
      const end = s.indexOf('"', pos + 1);
      if (end < 0) return null;
      const label = s.slice(pos + 1, end);
      let at = end + 1;
      while (at < s.length && s[at] === " ") at++;
      const close = closes.find((c) => s.startsWith(c, at));
      if (!close) return null;
      pos = at + close.length;
      return { label, close };
    }
    let best: { at: number; close: string } | null = null;
    for (const c of closes) {
      const at = s.indexOf(c, pos);
      if (at >= 0 && (!best || at < best.at)) best = { at, close: c };
    }
    if (!best) return null;
    const label = s.slice(pos, best.at);
    pos = best.at + best.close.length;
    return { label, close: best.close };
  }

  function readAtShape(m: Mention): boolean {
    // `@{ key: value, ... }`, values maybe quoted.
    let end = pos;
    let quoted = false;
    for (; end < s.length; end++) {
      if (s[end] === '"') quoted = !quoted;
      else if (s[end] === "}" && !quoted) break;
    }
    if (end >= s.length) return false;
    const body = s.slice(pos, end);
    pos = end + 1;
    const pairs = body.match(/(?:[^,"]|"[^"]*")+/g) ?? [];
    for (const pair of pairs) {
      const colon = pair.indexOf(":");
      if (colon < 0) continue;
      const key = pair.slice(0, colon).trim();
      const value = unquote(pair.slice(colon + 1));
      if (key === "shape") {
        const known = own(SHAPE_NAMES, value) ? SHAPE_NAMES[value] : undefined;
        if (known) m.shape = known;
        else {
          m.shape = { kind: "step" };
          m.unknownShape = value;
        }
      } else if (key === "label") {
        const c = cleanLabel(value);
        m.label = c.text;
        m.labelNotes = c.notes.map((f) => f("\u0000"));
      }
    }
    return true;
  }

  function readNode(): Mention | null {
    ws();
    const id = ID.exec(s.slice(pos));
    if (!id) return null;
    pos += id[0].length;
    const m: Mention = { id: id[0], labelNotes: [], classes: [] };
    const afterId = pos;
    if (s.startsWith("@{", pos)) {
      pos += 2;
      if (!readAtShape(m)) {
        unclosed = m.id;
        return null;
      }
    } else {
      ws();
      const spec = SHAPES.find((sh) => s.startsWith(sh.open, pos) && (!sh.tight || pos === afterId));
      if (spec) {
        pos += spec.open.length;
        const read = readLabel(spec.close);
        if (!read) {
          unclosed = m.id;
          return null;
        }
        m.shape = typeof spec.shape === "function" ? spec.shape(read.close) : spec.shape;
        const c = cleanLabel(read.label);
        m.label = c.text || undefined;
        m.labelNotes = c.notes.map((f) => f("\u0000"));
      } else pos = afterId;
    }
    const cls = /^:::([\w-]+)/.exec(s.slice(pos));
    if (cls) {
      m.classes.push(cls[1]);
      pos += cls[0].length;
    }
    return m;
  }

  function readGroup(): Mention[] | null {
    const first = readNode();
    if (!first) return null;
    const group = [first];
    for (;;) {
      const save = pos;
      ws();
      if (s[pos] !== "&") {
        pos = save;
        return group;
      }
      pos++;
      const next = readNode();
      if (!next) return null;
      group.push(next);
    }
  }

  function readLink(): LinkToken | null {
    const rest = s.slice(pos);
    const take = (m: RegExpExecArray, t: LinkToken): LinkToken => {
      pos += m[0].length;
      return t;
    };
    let m: RegExpExecArray | null;
    // Text labels: `-- yes -->`, `-. maybe .->`, `== big ==>`.
    if ((m = /^--\s+([^|]+?)\s+(-{2,}>|-{3,})/.exec(rest))) return take(m, { arrow: m[2].endsWith(">") ? ">" : "-", label: m[1] });
    if ((m = /^-\.\s*([^|]+?)\s*\.-+>/.exec(rest))) return take(m, { arrow: "-->", label: m[1] });
    if ((m = /^-\.\s*([^|]+?)\s*\.-(?![->])/.exec(rest)))
      return take(m, { arrow: "--", label: m[1] });
    if ((m = /^==\s+([^|]+?)\s+={2,}>/.exec(rest))) return take(m, { arrow: ">", label: m[1], note: "thick lines are drawn normal." });
    if ((m = /^==\s+([^|]+?)\s+={3,}(?!>)/.exec(rest))) return take(m, { arrow: "-", label: m[1], note: "thick lines are drawn normal." });
    let t: LinkToken | null = null;
    if ((m = /^([ox])-{2,}([ox])(?=\s)/.exec(rest))) t = take(m, { arrow: "<>", note: `the ends ${m[1]}--${m[2]} became arrows.` });
    else if ((m = /^<-{2,}>/.exec(rest))) t = take(m, { arrow: "<>" });
    else if ((m = /^<={2,}>/.exec(rest))) t = take(m, { arrow: "<>", note: "thick lines are drawn normal." });
    else if ((m = /^<-\.+->/.exec(rest))) t = take(m, { arrow: "<>", note: "the dotted line <-.-> is drawn as a plain line." });
    else if ((m = /^-{2,}>/.exec(rest))) t = take(m, { arrow: ">" });
    else if ((m = /^-{2,}o(?![\w])/.exec(rest))) t = take(m, { arrow: ">", note: "the circle end --o became an arrow." });
    else if ((m = /^-{2,}x(?![\w])/.exec(rest))) t = take(m, { arrow: ">", note: "the cross end --x became an arrow." });
    else if ((m = /^-{3,}/.exec(rest))) t = take(m, { arrow: "-" });
    else if ((m = /^-\.+->/.exec(rest))) t = take(m, { arrow: "-->" });
    else if ((m = /^-\.+-/.exec(rest))) t = take(m, { arrow: "--" });
    else if ((m = /^={2,}>/.exec(rest))) t = take(m, { arrow: ">", note: "thick lines are drawn normal." });
    else if ((m = /^={3,}/.exec(rest))) t = take(m, { arrow: "-", note: "thick lines are drawn normal." });
    else if ((m = /^~{3,}/.exec(rest))) t = take(m, { arrow: "-", hidden: true });
    if (!t) return null;
    const pipe = /^\s*\|([^|]*)\|/.exec(s.slice(pos));
    if (pipe) {
      pos += pipe[0].length;
      t.label = pipe[1];
    }
    if (t.label !== undefined) {
      const c = cleanLabel(unquote(t.label));
      t.label = c.text || undefined;
    }
    return t;
  }

  const linkError = () => ({ ok: false as const, error: `cannot read the link ${s}. ${LINK_HELP}` });
  const fail = () =>
    unclosed !== null ? { ok: false as const, error: `the shape of ${unclosed} is not closed.` } : null;

  const first = readGroup();
  if (!first) return fail() ?? { ok: false, error: `cannot read ${s}.` };
  const mentions = [...first];
  const links: RawLink[] = [];
  const notes: string[] = [];
  let prev = first;
  let hops = 0;
  for (;;) {
    ws();
    if (pos >= s.length) break;
    const link = readLink();
    if (!link) return fail() ?? linkError();
    const next = readGroup();
    if (!next) return fail() ?? linkError();
    mentions.push(...next);
    if (link.note) notes.push(link.note);
    if (link.hidden) notes.push("the hidden link ~~~ is left out.");
    else {
      if (linksBefore + links.length + prev.length * next.length > MAX_FLOW_LINKS) throw new LimitPassed(LINK_LIMIT);
      const single = prev.length === 1 && next.length === 1;
      for (const a of prev)
        for (const b of next)
          links.push({ from: a.id, to: b.id, arrow: link.arrow, label: link.label, chained: single && hops > 0 && !link.label });
    }
    hops = link.hidden ? 0 : hops + 1;
    prev = next;
  }
  return { ok: true, mentions, links, notes };
}

type RawNode = {
  id: string;
  label?: string;
  shape?: Shape;
  unknownShape?: string;
  /** Where its shape or label was last given, else where it was first named. */
  line: number;
  labelNotes: string[];
  group: RawGroup | null;
};
type RawGroup = { id: string; name: string; nodes: string[]; groups: RawGroup[] };

const LEFT_OUT: Record<string, string> = {
  style: "style is left out. Colours come from the theme.",
  linkStyle: "linkStyle is left out. Colours come from the theme.",
  classDef: "classDef is left out.",
  class: "class is left out.",
  click: "click is left out.",
  accTitle: "accTitle is left out.",
  accDescr: "accDescr is left out.",
};

/** Converts a Mermaid flowchart to .flow; `title` is used when the front matter has none. */
function flowchartToFlow(text: string, title: string): MermaidResult {
  const notes: MermaidNote[] = [];
  const errors: MermaidNote[] = [];
  const refuse = (line: number, message: string): MermaidResult => ({
    kind: "flow",
    count: "",
    flow: "",
    doc: { kind: "flow", title, comments: [], nodes: [], links: [], groups: [] },
    direction: "TB",
    notes: [],
    errors: [{ line, text: message }],
    nodes: 0,
    links: 0,
  });
  if (text.length > MAX_MERMAID_CHARS || (text.length * 3 > MAX_MERMAID_CHARS && new TextEncoder().encode(text).length > MAX_MERMAID_CHARS)) return refuse(0, "This Mermaid text is larger than 1 MB.");

  const lines = text.split(/\r?\n/);
  const noted = new Set<string>();
  const note = (line: number, t: string) => {
    const full = `Line ${line}: ${t}`;
    if (noted.has(full)) return;
    noted.add(full);
    notes.push({ line, text: full });
  };
  const comments: FlowDoc["comments"] = [];

  // Front matter: `---`, `title: ...`, `---`.
  let at = 0;
  if (lines[0]?.trim() === "---") {
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
    if (close > 0) {
      for (const l of lines.slice(1, close)) {
        const t = /^\s*title:\s*(.*)$/.exec(l);
        if (t && unquote(t[1])) title = unquote(t[1]);
      }
      at = close + 1;
    }
  }

  // The header: the first line that is neither blank nor a comment.
  let direction: "TB" | "LR" = "TB";
  let headerRest = "";
  let headerLine = 0;
  for (; at < lines.length; at++) {
    const t = lines[at].trim();
    if (!t) continue;
    if (t.startsWith("%%")) {
      if (!t.startsWith("%%{")) comments.push({ line: at + 1, text: t.slice(2).trim() });
      else note(at + 1, "the %%{ }%% setting is left out.");
      continue;
    }
    headerLine = at + 1;
    const h = /^(flowchart|graph)(-elk)?\b\s*(.*)$/i.exec(t);
    if (!h) {
      const word = t.split(/[\s;:{]/)[0];
      return refuse(
        headerLine,
        OTHER_DIAGRAM.test(word)
          ? `Only Mermaid flowcharts can be imported. This is a ${word}.`
          : `Line ${headerLine}: a Mermaid flowchart starts with flowchart or graph.`,
      );
    }
    const d = /^(TD|TB|LR|RL|BT)\b\s*;?\s*(.*)$/i.exec(h[3]);
    if (d) {
      const dir = d[1].toUpperCase();
      direction = dir === "LR" || dir === "RL" ? "LR" : "TB";
      if (dir === "RL") note(headerLine, "RL is drawn left to right.");
      if (dir === "BT") note(headerLine, "BT is drawn top to bottom.");
      headerRest = d[2];
    } else headerRest = h[3].replace(/^;/, "");
    at++;
    break;
  }

  const nodes = new Map<string, RawNode>();
  const rawLinks: (RawLink & { line: number })[] = [];
  const roots: RawGroup[] = [];
  const subgraphs = new Map<string, RawGroup>();
  const stack: RawGroup[] = [];
  let inAccBlock = false;
  let groupCount = 0;

  function commit(p: Extract<Parsed, { ok: true }>, line: number) {
    for (const m of p.mentions) {
      let n = nodes.get(m.id);
      if (!n) {
        n = { id: m.id, line, labelNotes: [], group: null };
        nodes.set(m.id, n);
        // Subgraph ids named in links are not nodes; the exact count is taken once they are known.
        if (nodes.size > MAX_FLOW_NODES + subgraphs.size) throw new LimitPassed(NODE_LIMIT);
      }
      if (m.shape || m.label !== undefined) {
        if (m.shape) {
          n.shape = m.shape;
          n.unknownShape = m.unknownShape;
        }
        if (m.label !== undefined) n.label = m.label;
        n.labelNotes = m.labelNotes;
        n.line = line;
      }
      const top = stack[stack.length - 1];
      if (top && !n.group) {
        n.group = top;
        top.nodes.push(n.id);
      }
      for (const c of m.classes) note(line, `the class :::${c} is left out.`);
    }
    for (const t of p.notes) note(line, t);
    for (const l of p.links) rawLinks.push({ ...l, line });
  }

  function statement(s: string, line: number) {
    const word = /^[A-Za-z]+/.exec(s)?.[0] ?? "";
    if (word === "subgraph" && /^subgraph(\s|$)/.test(s)) {
      const rest = s.slice(8).trim();
      const bracket = /^([^\s[]+)\s*\[(.*)\]$/.exec(rest);
      const id = bracket ? bracket[1] : unquote(rest);
      const name = bracket ? cleanLabel(unquote(bracket[2])).text || id : cleanLabel(unquote(rest)).text;
      if (!id || !name) {
        errors.push({ line, text: `Line ${line}: cannot read ${s}.` });
        return;
      }
      if (stack.length >= MAX_GROUP_DEPTH) throw new LimitPassed(DEPTH_LIMIT);
      if (++groupCount > MAX_GROUPS) throw new LimitPassed(GROUP_LIMIT);
      const g: RawGroup = { id, name, nodes: [], groups: [] };
      (stack.length ? stack[stack.length - 1].groups : roots).push(g);
      stack.push(g);
      subgraphs.set(id, g);
      return;
    }
    if (s === "end") {
      if (stack.length) stack.pop();
      else errors.push({ line, text: `Line ${line}: end has no subgraph to close.` });
      return;
    }
    if (word === "direction" && /^direction\s/.test(s)) {
      note(line, stack.length ? "direction inside a subgraph is left out." : "direction is left out.");
      return;
    }
    const p = parseStatement(s, rawLinks.length);
    if (p.ok) commit(p, line);
    else errors.push({ line, text: `Line ${line}: ${p.error}` });
  }

  const body: { text: string; line: number }[] = headerRest ? [{ text: headerRest, line: headerLine }] : [];
  for (; at < lines.length; at++) body.push({ text: lines[at], line: at + 1 });
  try {
    for (const { text: raw, line } of body) readLine(raw, line);
  } catch (e) {
    if (e instanceof LimitPassed) return refuse(0, e.message);
    throw e;
  }

  function readLine(raw: string, line: number) {
    const t = raw.trim();
    if (!t) return;
    if (inAccBlock) {
      if (t.includes("}")) inAccBlock = false;
      return;
    }
    if (t.startsWith("%%")) {
      if (t.startsWith("%%{")) note(line, "the %%{ }%% setting is left out.");
      else comments.push({ line, text: t.slice(2).trim() });
      return;
    }
    const word = /^[A-Za-z]+/.exec(t)?.[0] ?? "";
    if (own(LEFT_OUT, word) && new RegExp(`^${word}(\\s|:|\\{|$)`).test(t)) {
      note(line, LEFT_OUT[word]);
      if (word === "accDescr" && /^accDescr\s*\{/.test(t) && !t.includes("}")) inAccBlock = true;
      return;
    }
    for (const s of splitStatements(t)) statement(s, line);
  }

  // A link end that names a subgraph, and was never given a shape or label, links to its group.
  const toGroup = new Map<string, string>();
  for (const [id, g] of subgraphs) {
    const n = nodes.get(id);
    if (n && !n.shape && n.label === undefined) {
      toGroup.set(id, g.name);
      nodes.delete(id);
      if (n.group) n.group.nodes = n.group.nodes.filter((x) => x !== id);
    }
  }

  if (nodes.size > MAX_FLOW_NODES) return refuse(0, NODE_LIMIT);

  // Names: the label, else the id. A repeated one, or one a group has, gets the next free name and shows the same
  // words through `label:` (step 11: `Retry 2 [label: Retry]`, as Mermaid's id[label]).
  const names = new Map<string, string>();
  const shows = new Map<string, string>();
  const groupNames = new Set<string>([...subgraphs.values()].map((g) => g.name));
  const used = new Set<string>(groupNames);
  const seen = new Map<string, number>();
  for (const n of nodes.values()) {
    const base = n.label || n.id;
    let name = base;
    for (let k = 2; used.has(name); k++) name = `${base} ${k}`;
    if (name !== base) {
      shows.set(n.id, base);
      const k = (seen.get(base) ?? 1) + 1;
      seen.set(base, k);
      const said = `${name} with label: ${base}`;
      if (groupNames.has(base) && k === 2) note(n.line, `a group is named ${base}. The node comes in as ${said}, so it shows the same words.`);
      else note(n.line, k === 2 ? `two nodes show ${base}. The second comes in as ${said}, so it shows the same words.` : `more nodes show ${base}. This one comes in as ${said}.`);
    } else seen.set(base, 1);
    used.add(name);
    names.set(n.id, name);
  }
  const nameOf = (id: string) => names.get(id) ?? toGroup.get(id) ?? id;

  const hasIn = new Set(rawLinks.map((l) => l.to));
  const hasOut = new Set(rawLinks.map((l) => l.from));
  const flowNodes = [...nodes.values()].map((n) => {
    const name = nameOf(n.id);
    for (const t of n.labelNotes) note(n.line, t.replace("\u0000", name));
    let kind: FlowKind = "step";
    let icon: string | undefined;
    const shape = n.shape;
    if (shape?.kind === "decision" || shape?.kind === "io" || shape?.kind === "subprocess") kind = shape.kind;
    else if (shape?.kind === "database") {
      icon = "database";
      note(n.line, "the cylinder [( )] became a step with the database icon.");
    } else if (shape?.kind === "foreign") note(n.line, `the ${shape.what} is not a .flow shape. ${name} became a step.`);
    else if (shape?.kind === "round") {
      if (!hasIn.has(n.id)) kind = "start";
      else if (!hasOut.has(n.id)) kind = "end";
      else note(n.line, `the ${shape.what} ${name} has links in and out, so it became a step.`);
    }
    if (n.unknownShape) note(n.line, `the shape ${n.unknownShape} is not a .flow shape. ${name} became a step.`);
    if (needsQuotes(name)) note(n.line, `${name} has characters .flow reserves, so it is written in quotes.`);
    const label = shows.get(n.id);
    const node: FlowNode = { name, kind, attrs: { ...(icon ? { icon } : {}), ...(label !== undefined ? { label } : {}) } };
    return node;
  });

  const toFlowGroup = (g: RawGroup): FlowGroup => ({ name: g.name, nodes: g.nodes.map(nameOf), groups: g.groups.map(toFlowGroup) });
  const links: FlowLink[] = rawLinks.map((l) => {
    const out: FlowLink = { from: nameOf(l.from), to: nameOf(l.to), arrow: l.arrow };
    if (l.label) out.label = l.label;
    if (l.chained) out.chained = true;
    return out;
  });

  const doc: FlowDoc = { kind: "flow", title, comments, nodes: flowNodes, links, groups: roots.map(toFlowGroup) };
  notes.sort((a, b) => a.line - b.line);
  errors.sort((a, b) => a.line - b.line);
  return { kind: "flow", count: "", flow: writeFlow(doc), doc, direction, notes, errors, nodes: flowNodes.length, links: links.length };
}

// ----- step 10 (F28): every Mermaid kind Contura has

const COMES_IN = "The Mermaid diagrams that come in are flowchart, sequence, state, class, mindmap and timeline.";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** What came in, said by kind (board DiagramStartWell). */
function countOf(doc: FlowDoc): string {
  const shapes = doc.nodes.filter((n) => n.kind !== "note" && n.kind !== "start" && n.kind !== "end");
  const lines = doc.links.filter((l) => !l.tree).length;
  switch (doc.kind) {
    case "sequence":
      return `Sequence: ${plural(shapes.length, "participant")}, ${plural(lines, "message")}`;
    case "state":
      return `State: ${plural(doc.nodes.filter((n) => n.kind !== "note" && !n.name.startsWith("[*]")).length, "state")}, ${plural(lines, "transition")}`;
    case "class":
      return `Class: ${plural(shapes.length, "class", "classes")}, ${plural(lines, "relationship")}`;
    case "mindmap":
      return `Mind map: ${plural(shapes.length, "topic")}`;
    case "timeline":
      return `Timeline: ${plural(shapes.length, "item")}`;
    default:
      return `Flowchart: ${plural(doc.nodes.length, "shape")}, ${plural(lines, "line")}`;
  }
}

export interface MermaidOptions {
  /**
   * A paste translated in place (user decision, 25 Oct): each line that cannot be read is kept as a `//` comment
   * with its reason, after the first line, so nothing is dropped silently.
   */
  keepUnread?: boolean;
}

/** Converts Mermaid of any kind Contura has to .flow; `title` is used when the Mermaid names none. */
export function mermaidToFlow(text: string, title: string, opts: MermaidOptions = {}): MermaidResult {
  const empty = (line: number, message: string): MermaidResult => ({
    kind: "flow",
    count: "",
    flow: "",
    doc: { kind: "flow", title, comments: [], nodes: [], links: [], groups: [] },
    direction: "TB",
    notes: [],
    errors: [{ line, text: message }],
    nodes: 0,
    links: 0,
  });
  if (overSize(text)) return empty(0, "This Mermaid text is larger than 1 MB.");
  const lines = text.split(/\r?\n/);
  const { at, head, title: front } = headOf(lines);
  const word = kindWord(head);
  if (word === "erDiagram") return empty(at + 1, ER_REFUSED);
  const kind = word ? MERMAID_KINDS[word] : null;
  let result: MermaidResult;
  if (kind === null || kind === "flow") {
    const first = /^[A-Za-z][\w-]*/.exec(head)?.[0] ?? "";
    // A word that is a Mermaid kind of its own (pie, gantt, ...) is refused by name.
    if (kind === null && first && OTHER_DIAGRAM.test(first)) return empty(at + 1, `Line ${at + 1}: Contura has no ${first} kind. ${COMES_IN}`);
    // A directive over several lines before the header is blanked, so the flowchart reader starts at the header; the
    // line numbers stay (fix round 1, M2).
    const lead = front === null ? lines.slice(0, at) : [];
    const directive = lead.some((l) => l.trim().startsWith("%%{") && !l.includes("}%%"));
    const read = directive ? [...lead.map(() => ""), ...lines.slice(at)].join("\n") : text;
    result = flowchartToFlow(read, title);
    if (directive) result.notes.unshift({ line: lead.findIndex((l) => l.trim().startsWith("%%{")) + 1, text: `Line ${lead.findIndex((l) => l.trim().startsWith("%%{")) + 1}: the %%{ }%% setting is left out.` });
    result.count = result.nodes > 0 ? countOf(result.doc) : "";
  } else {
    const notes: MermaidNote[] = [];
    const errors: MermaidNote[] = [];
    const body = lines.slice(at + 1).map((raw, i) => ({ raw, t: raw.trim(), line: at + 2 + i }));
    const c: KindContext = {
      body,
      headLine: at + 1,
      note: (line, t) => notes.push({ line, text: `Line ${line}: ${t}` }),
      error: (line, t) => errors.push({ line, text: `Line ${line}: ${t}` }),
      title: front ?? title,
    };
    const out: KindOut =
      kind === "sequence" ? sequenceToFlow(c) : kind === "state" ? stateToFlow(c) : kind === "class" ? classToFlow(c) : kind === "mindmap" ? mindmapToFlow(c, front !== null) : timelineToFlow(c);
    const parsed = parseFlow(out.flow).doc ?? { kind, title: out.title, comments: [], nodes: [], links: [], groups: [] };
    notes.sort((a, b) => a.line - b.line);
    errors.sort((a, b) => a.line - b.line);
    const shapes = parsed.nodes.filter((n) => n.kind !== "note").length;
    result = { kind, count: shapes > 0 ? countOf(parsed) : "", flow: out.flow, doc: parsed, direction: "TB", notes, errors, nodes: shapes, links: parsed.links.filter((l) => !l.tree).length };
  }
  if (opts.keepUnread && result.errors.length > 0 && result.flow) {
    const nl = result.flow.indexOf("\n");
    // The line itself, then why it was not read (fix round 1, I3): nothing of the Mermaid is lost.
    const kept = result.errors
      .filter((e) => e.line > 0)
      .map((e) => `// ${(lines[e.line - 1] ?? "").trim()}  // ${e.text.replace(/^Line \d+: /, "").replace(/[\r\n]+/g, " ")}`);
    if (kept.length) result = { ...result, flow: `${result.flow.slice(0, nl + 1)}${kept.join("\n")}\n${result.flow.slice(nl + 1)}` };
  }
  return result;
}

const overSize = (text: string) => text.length > MAX_MERMAID_CHARS || (text.length * 3 > MAX_MERMAID_CHARS && new TextEncoder().encode(text).length > MAX_MERMAID_CHARS);
