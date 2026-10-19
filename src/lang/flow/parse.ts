// The .flow parser (A2): a hand-written line lexer with no regular expressions on the text, so a long line
// costs one pass. It runs in the language worker, returns problems with fixes, and never throws on odd text.
import type { QuickFix } from "../protocol";
import {
  ATTR_KEYS,
  DIAGRAM_KINDS,
  type DiagramKind,
  type FlowArrow,
  type FlowDoc,
  type FlowGroup,
  type FlowLink,
  type FlowNode,
  type FlowNodeKind,
  flowName,
  KINDS,
  MAX_GROUP_DEPTH,
} from "./model";
import { FIX_TITLES, type FlowProblem, MESSAGES, nearestNames, nearWord } from "./problems";

export type { FlowProblem } from "./problems";

export type FlowRange = { from: number; to: number };

/**
 * A source range with the ranges of its parts, one key per element.
 * - `diagram`, `kind`, `title`: plain ranges.
 * - `node:<name>`: the statement; `name`, and when it has brackets `attrs`, `kind` and `values` (each attribute's value).
 * - `group:<name>`: through its `}`; `name`, `open` (`{`), `close` (`}`), `attrs`, `values`.
 * - `link:<i>`: from its first name to its second; `fromName`, `toName`, `arrow`, `label`, and `line` (the whole statement).
 */
export type FlowSpan = FlowRange & {
  name?: FlowRange;
  attrs?: FlowRange;
  kind?: FlowRange;
  values?: Record<string, FlowRange>;
  open?: FlowRange;
  close?: FlowRange;
  fromName?: FlowRange;
  toName?: FlowRange;
  arrow?: FlowRange;
  label?: FlowRange;
  line?: FlowRange;
};

export type FlowParse = {
  /** The kind on the first line; null when the first line is wrong. */
  kind: DiagramKind | null;
  /** Null while the text has an error; hints alone keep it. */
  doc: FlowDoc | null;
  problems: FlowProblem[];
  /** The 1-based line each node and group is defined on, kept while the text has errors. */
  readonly lineOf: Record<string, number>;
  /** The source ranges of one element (see FlowSpan), kept while the text has errors; null when there is none. */
  span(key: string): FlowSpan | null;
  /** Every span, built on first read (the parse itself keeps them packed as numbers, so it stays fast). */
  readonly ranges: Record<string, FlowSpan>;
  /** Each node and group name, in the order they are defined, with its line; a Map, so any name is a plain key. */
  readonly defined: ReadonlyMap<string, number>;
  /** Every link that was read, kept while the text has errors; `link:<i>` spans index this list. */
  readonly links: readonly FlowLink[];
  /** The group a node or group is in: null at the top, undefined when the name is not defined. */
  parentOf(name: string): string | null | undefined;
  /** Names defined more than once (each is already a problem). */
  readonly definedTwice: ReadonlySet<string>;
};

// Packed spans: `[from, to, ...parts]`, each part a from/to pair, -1 where the element has no such part.
const NODE_PARTS = ["name", "attrs", "kind"] as const;
const GROUP_PARTS = ["name", "attrs", "open", "close"] as const;
const LINK_PARTS = ["fromName", "toName", "arrow", "label", "line"] as const;
type Part = (typeof NODE_PARTS)[number] | (typeof GROUP_PARTS)[number] | (typeof LINK_PARTS)[number];

function partsOf(key: string): readonly Part[] {
  if (key.startsWith("node:")) return NODE_PARTS;
  if (key.startsWith("group:")) return GROUP_PARTS;
  if (key.startsWith("link:")) return LINK_PARTS;
  return [];
}

function unpack(key: string, packed: number[], values: Record<string, FlowRange> | undefined): FlowSpan {
  const span: FlowSpan = { from: packed[0], to: packed[1] };
  partsOf(key).forEach((part, i) => {
    const from = packed[2 + 2 * i];
    if (from >= 0) span[part] = { from, to: packed[3 + 2 * i] };
  });
  if (values) span.values = values;
  return span;
}

export type FlowParseOptions = {
  /** Every icon name; given, a cloud diagram checks its icons against it. */
  icons?: ReadonlySet<string>;
  /**
   * The nearest icon name found for each misspelt one, kept across parses by the caller (the worker), so a name
   * misspelt on many lines is compared with the thousands of icon names once.
   */
  iconNear?: Map<string, string | null>;
};

/** The misspelt icon cache keeps at most this many names, dropping the oldest first. */
const ICON_NEAR_CAP = 2000;

/**
 * Icon names one parse may compare for "Did you mean" (as P5's Send-it-to budget): about 24 lookups over the
 * packed set. Names past it still get the hint, without a suggestion, until a later parse has looked them up.
 */
export const ICON_LOOKUP_BUDGET = 100_000;

/** More than this many problems is noise; the rest still count as errors. */
const MAX_PROBLEMS = 200;

const BAD = Symbol("bad");

type Token = { value: string; from: number; to: number };
type Attrs = {
  from: number;
  /** After the `]`, or the end of what was read when it is missing. */
  to: number;
  kind: Token | null;
  attrs: Record<string, string>;
  values: Record<string, FlowRange>;
  keys: string[];
  empty: boolean;
};
type GroupBuild = {
  name: string;
  icon?: string;
  nodes: string[];
  groups: GroupBuild[];
  from: number;
  nameTo: number;
  line: number;
  /** A second group of the same name, or one nested too deep: it pairs its braces but stays out of the tree. */
  repeated: boolean;
};
type Use = { name: string; from: number; to: number; line: number; end: "from" | "to"; other: string };

/** The same characters as the `\s` in the writer's quoting rule. */
function isWs(c: number): boolean {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 0xa0) return false;
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}


class Parser {
  private readonly s: string;
  private readonly icons: ReadonlySet<string> | undefined;
  private problems: FlowProblem[] = [];
  private fixers: (() => QuickFix[])[] = [];
  private errors = 0;
  private kind: DiagramKind | null = null;
  private title = "";
  private header = false;
  private comments: FlowDoc["comments"] = [];
  private defs = new Map<string, number>();
  private twice = new Set<string>();
  private nodes: { node: FlowNode; grouped: boolean }[] = [];
  private byName = new Map<string, FlowNode>();
  private roots: GroupBuild[] = [];
  private stack: GroupBuild[] = [];
  private links: FlowLink[] = [];
  private linkLines: number[] = [];
  /** Spans of the nodes, groups and first line, by key; links are in `linkPacked` by index. */
  private packed = new Map<string, number[]>();
  private linkPacked: number[][] = [];
  private values = new Map<string, Record<string, FlowRange>>();
  private line = 0;
  /** Name comparisons left for "Send it to" fixes in this parse. */
  private compareBudget = 100_000;
  private nearCache = new Map<string, string[]>();
  private candidates: { name: string; lower: string; band: number }[] | null = null;

  constructor(text: string, opts: FlowParseOptions) {
    this.s = text;
    this.icons = opts.icons;
    this.iconNear = opts.iconNear ?? new Map();
  }

  private readonly iconNear: Map<string, string | null>;
  /** Icon names compared for suggestions in this parse (ICON_LOOKUP_BUDGET). */
  private iconLookups = 0;

  run(): FlowParse {
    const s = this.s;
    let start = 0;
    for (;;) {
      let nl = s.indexOf("\n", start);
      if (nl < 0) nl = s.length;
      const end = nl > start && s.charCodeAt(nl - 1) === 13 ? nl - 1 : nl;
      this.line++;
      this.statement(start, end);
      if (nl >= s.length) break;
      start = nl + 1;
    }
    this.finish();
    const doc = this.kind && this.errors === 0 ? this.doc(this.kind) : null;
    const order = this.problems.map((p, i) => ({ p, i })).sort((a, b) => a.p.from - b.p.from || a.i - b.i);
    const problems = order.map(({ p, i }) => ({ ...p, fixes: this.fixers[i]() }));
    const { packed, linkPacked, values, defs, roots, nodes } = this;
    // Built on first ask from the group tree, so a parse that no edit reads pays nothing for it.
    let parents: Map<string, string | null> | null = null;
    const parentOf = (name: string) => {
      if (!parents) {
        const m = new Map<string, string | null>();
        for (const n of nodes) if (!n.grouped) m.set(n.node.name, null);
        const stack = roots.map((g) => ({ g, parent: null as string | null }));
        for (let top = stack.pop(); top; top = stack.pop()) {
          const { g, parent } = top;
          m.set(g.name, parent);
          for (const n of g.nodes) m.set(n, g.name);
          for (const c of g.groups) stack.push({ g: c, parent: g.name });
        }
        parents = m;
      }
      return parents.get(name);
    };
    const span = (key: string): FlowSpan | null => {
      if (key.startsWith("link:")) {
        const p = linkPacked[Number(key.slice(5))];
        return p ? unpack(key, p, undefined) : null;
      }
      const p = packed.get(key);
      return p ? unpack(key, p, values.get(key)) : null;
    };
    let all: Record<string, FlowSpan> | null = null;
    let lines: Record<string, number> | null = null;
    return {
      kind: this.kind,
      doc,
      problems,
      span,
      defined: defs,
      links: this.links,
      parentOf,
      definedTwice: this.twice,
      // Built on first read: the worker answers line questions from `defs`, so most parses never build these.
      get lineOf() {
        if (!lines) {
          lines = Object.create(null) as Record<string, number>;
          for (const [name, line] of defs) lines[name] = line;
        }
        return lines;
      },
      get ranges() {
        if (!all) {
          const out = Object.create(null) as Record<string, FlowSpan>;
          for (const [key, p] of packed) out[key] = unpack(key, p, values.get(key));
          linkPacked.forEach((p, i) => {
            out[`link:${i}`] = unpack("link:", p, undefined);
          });
          all = out;
        }
        return all;
      },
    };
  }

  // ----- problems

  private problem(severity: FlowProblem["severity"], from: number, to: number, message: string, fixes: () => QuickFix[] = () => [], line = this.line) {
    if (severity === "error") this.errors++;
    if (this.problems.length >= MAX_PROBLEMS) return;
    this.problems.push({ line, from, to, severity, message, fixes: [] });
    this.fixers.push(fixes);
  }

  private error(from: number, to: number, message: string, fixes?: () => QuickFix[], line?: number) {
    this.problem("error", from, to, message, fixes, line);
  }

  // ----- the lexer

  private ws(p: number, e: number): number {
    while (p < e && isWs(this.s.charCodeAt(p))) p++;
    return p;
  }

  private isComment(p: number, e: number): boolean {
    return p + 1 < e && this.s.charCodeAt(p) === 47 && this.s.charCodeAt(p + 1) === 47;
  }

  /** The end of the text before `p`, without the white space. */
  private trimBack(p: number, from: number): number {
    while (p > from && isWs(this.s.charCodeAt(p - 1))) p--;
    return p;
  }

  /** Where an unquoted name stops: the characters the writer's quoting rule reserves. */
  private stopsName(j: number, e: number): boolean {
    const s = this.s;
    switch (s.charCodeAt(j)) {
      case 91: // [
      case 93: // ]
      case 123: // {
      case 125: // }
      case 58: // :
      case 62: // >
      case 60: // <
      case 34: // "
      case 92: // \
        return true;
      case 47: // a // comment
        return j + 1 < e && s.charCodeAt(j + 1) === 47;
      case 45: // -- anywhere, or a lone -
        if (j + 1 < e && s.charCodeAt(j + 1) === 45) return true;
        return (j === 0 || isWs(s.charCodeAt(j - 1))) && (j + 1 >= e || isWs(s.charCodeAt(j + 1)));
      case 46: // the ..> arrow
        return j + 2 < e && s.charCodeAt(j + 1) === 46 && s.charCodeAt(j + 2) === 62;
    }
    return false;
  }

  /** A quoted string at `p`, with `\"` and `\\`; null when the line ends first. */
  private quoted(p: number, e: number): { value: string; end: number } | null {
    const s = this.s;
    let out = "";
    let chunk = p + 1;
    for (let j = p + 1; j < e; j++) {
      const c = s.charCodeAt(j);
      if (c === 92 && j + 1 < e) {
        const next = s.charCodeAt(j + 1);
        out += s.slice(chunk, j) + (next === 110 ? "\n" : next === 114 ? "\r" : s[j + 1]);
        j++;
        chunk = j + 1;
      } else if (c === 34) {
        return { value: out + s.slice(chunk, j), end: j + 1 };
      }
    }
    return null;
  }

  /** A name at `p`: null when there is none, BAD when its quote never closes (the problem is recorded). */
  private name(p: number, e: number): Token | null | typeof BAD {
    if (p < e && this.s.charCodeAt(p) === 34) {
      const q = this.quoted(p, e);
      if (!q) {
        this.error(p, this.trimBack(e, p), MESSAGES.nameQuote);
        return BAD;
      }
      return { value: q.value, from: p, to: q.end };
    }
    let j = p;
    while (j < e && !this.stopsName(j, e)) j++;
    const to = this.trimBack(j, p);
    return to === p ? null : { value: this.s.slice(p, to), from: p, to };
  }

  private arrow(q: number, e: number): FlowArrow | null {
    const s = this.s;
    if (q >= e) return null;
    const c = s.charCodeAt(q);
    if (c === 62) return ">";
    if (c === 60) return q + 1 < e && s.charCodeAt(q + 1) === 62 ? "<>" : null;
    if (c === 45) {
      if (q + 2 < e && s.charCodeAt(q + 1) === 45 && s.charCodeAt(q + 2) === 62) return "-->";
      return q + 1 >= e || isWs(s.charCodeAt(q + 1)) ? "-" : null;
    }
    if (c === 46) return q + 2 < e && s.charCodeAt(q + 1) === 46 && s.charCodeAt(q + 2) === 62 ? "..>" : null;
    return null;
  }

  private comment(p: number, e: number) {
    this.comments.push({ line: this.line, text: this.s.slice(p + 2, e).trim() });
  }

  /** The rest of the statement must be empty or a comment. */
  private end(q: number, e: number): boolean {
    q = this.ws(q, e);
    if (q >= e) return true;
    if (this.isComment(q, e)) {
      this.comment(q, e);
      return true;
    }
    let stop = q;
    while (stop < e && !this.isComment(stop, e)) stop++;
    stop = this.trimBack(stop, q);
    this.error(q, stop, MESSAGES.extra(this.s.slice(q, stop)));
    return false;
  }

  // ----- statements

  private statement(a: number, e: number) {
    const p = this.ws(a, e);
    if (p >= e) return;
    if (this.isComment(p, e)) return this.comment(p, e);
    if (!this.header) {
      this.header = true;
      if (this.diagramLine(p, e)) return;
    }
    if (this.s.charCodeAt(p) === 125) return this.close(p, e);
    this.nameStatement(p, e);
  }

  private diagramLine(p: number, e: number): boolean {
    const s = this.s;
    if (!(s.startsWith("diagram", p) && (p + 7 >= e || isWs(s.charCodeAt(p + 7))))) {
      const at = this.lineStartOf(p);
      this.error(p, this.lineEnd(p, e), MESSAGES.firstLine, () =>
        DIAGRAM_KINDS.map((k) => ({ title: FIX_TITLES.addFirstLine(k), edits: [{ from: at, to: at, insert: `diagram ${k} "Untitled"\n` }] })),
      );
      return false;
    }
    const q = this.ws(p + 7, e);
    let r = q;
    // The kind word runs to white space, a quote or a comment, so `flow2` is read whole and refused.
    while (r < e && !isWs(s.charCodeAt(r)) && s.charCodeAt(r) !== 34 && !this.isComment(r, e)) r++;
    const word = s.slice(q, r);
    if ((DIAGRAM_KINDS as readonly string[]).includes(word)) {
      this.kind = word as DiagramKind;
      this.packed.set("kind", [q, r]);
    } else {
      const from = r > q ? q : p;
      const to = r > q ? r : p + 7;
      this.error(from, to, MESSAGES.firstLine, () =>
        DIAGRAM_KINDS.map((k) => ({ title: FIX_TITLES.kind(k), edits: r > q ? [{ from: q, to: r, insert: k }] : [{ from: p + 7, to: p + 7, insert: ` ${k}` }] })),
      );
    }
    let stop = r;
    const t = this.ws(r, e);
    if (t < e && s.charCodeAt(t) === 34) {
      const qt = this.quoted(t, e);
      if (!qt) {
        this.error(t, this.trimBack(e, t), MESSAGES.titleQuote);
        this.packed.set("diagram", [p, this.trimBack(e, p)]);
        return true;
      }
      this.title = qt.value;
      this.packed.set("title", [t, qt.end]);
      stop = qt.end;
      this.end(qt.end, e);
    } else if (t < e && !this.isComment(t, e)) {
      let j = t;
      while (j < e && !this.isComment(j, e)) j++;
      stop = this.trimBack(j, t);
      this.title = s.slice(t, stop);
      this.packed.set("title", [t, stop]);
      if (j < e) this.comment(j, e);
    } else {
      this.end(t, e);
    }
    this.packed.set("diagram", [p, stop]);
    return true;
  }

  /** The start of the line holding `p`. */
  private lineStartOf(p: number): number {
    return this.s.lastIndexOf("\n", p - 1) + 1;
  }

  /** The end of the statement at `p`, before any comment and white space. */
  private lineEnd(p: number, e: number): number {
    let j = p;
    let inQuote = false;
    for (; j < e; j++) {
      const c = this.s.charCodeAt(j);
      if (c === 34) inQuote = !inQuote;
      else if (!inQuote && this.isComment(j, e)) break;
    }
    return this.trimBack(j, p);
  }

  private close(p: number, e: number) {
    const g = this.stack.pop();
    if (!g) {
      this.error(p, p + 1, MESSAGES.strayClose, () => [{ title: FIX_TITLES.remove, edits: [{ from: p, to: p + 1, insert: "" }] }]);
    } else {
      const span = g.repeated ? undefined : this.packed.get(`group:${g.name}`);
      if (span) {
        span[1] = p + 1;
        span[8] = p;
        span[9] = p + 1;
      }
    }
    this.end(p + 1, e);
  }

  private nameStatement(p: number, e: number) {
    const first = this.name(p, e);
    if (first === BAD) return;
    if (!first) {
      this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
      return;
    }
    const q = this.ws(first.to, e);
    const arrow = this.arrow(q, e);
    if (arrow) return this.link(first, q, arrow, e);
    const c = q < e ? this.s.charCodeAt(q) : -1;
    if (c === 91) {
      const attrs = this.attrs(q, e);
      const r = this.ws(attrs.to, e);
      if (r < e && this.s.charCodeAt(r) === 123) return this.openGroup(first, attrs, r, e);
      this.node(first, attrs, attrs.to);
      if (attrs.to > q && this.s.charCodeAt(attrs.to - 1) === 93) this.end(attrs.to, e);
      return;
    }
    if (c === 123) return this.openGroup(first, null, q, e);
    this.node(first, null, first.to);
    this.end(q, e);
  }

  private attrs(q: number, e: number): Attrs {
    const s = this.s;
    const out: Attrs = { from: q, to: q + 1, kind: null, attrs: {}, values: {}, keys: [], empty: true };
    const unclosed = (at: number) => {
      out.to = this.trimBack(at, q);
      this.error(q, out.to, MESSAGES.openList);
      return out;
    };
    let j = this.ws(q + 1, e);
    if (j < e && s.charCodeAt(j) === 93) {
      out.to = j + 1;
      return out;
    }
    for (;;) {
      j = this.ws(j, e);
      if (j >= e || this.isComment(j, e)) return unclosed(j);
      let k = j;
      while (k < e) {
        const c = s.charCodeAt(k);
        if (c === 58 || c === 44 || c === 93 || this.isComment(k, e)) break;
        k++;
      }
      const wordTo = this.trimBack(k, j);
      const word = s.slice(j, wordTo);
      let after = k;
      if (k < e && s.charCodeAt(k) === 58) {
        out.empty = false;
        const v = this.ws(k + 1, e);
        let value: string;
        let range: FlowRange;
        let quotedValue = false;
        if (v < e && s.charCodeAt(v) === 34) {
          const qv = this.quoted(v, e);
          if (!qv) {
            this.error(v, this.trimBack(e, v), MESSAGES.textQuote);
            out.to = this.trimBack(e, q);
            return out;
          }
          value = qv.value;
          range = { from: v, to: qv.end };
          after = qv.end;
          quotedValue = true;
        } else {
          let m = v;
          while (m < e) {
            const c = s.charCodeAt(m);
            if (c === 44 || c === 93 || this.isComment(m, e)) break;
            m++;
          }
          const vt = this.trimBack(m, v);
          value = s.slice(v, vt);
          range = { from: v, to: vt };
          after = m;
        }
        if ((ATTR_KEYS as readonly string[]).includes(word)) {
          if (value === "" && !quotedValue) this.error(j, wordTo, MESSAGES.noValue(word));
          else {
            out.attrs[word] = value;
            out.values[word] = range;
            out.keys.push(word);
          }
        } else {
          const near = nearWord(word, ATTR_KEYS);
          this.error(j, wordTo, MESSAGES.unknownAttr(word), () => (near ? [{ title: FIX_TITLES.use(near), edits: [{ from: j, to: wordTo, insert: near }] }] : []));
        }
      } else if (word !== "") {
        out.empty = false;
        if (out.kind) this.error(j, wordTo, MESSAGES.oneKind);
        else out.kind = { value: word, from: j, to: wordTo };
      }
      const a = this.ws(after, e);
      if (a < e && s.charCodeAt(a) === 44) {
        j = a + 1;
        continue;
      }
      if (a < e && s.charCodeAt(a) === 93) {
        out.to = a + 1;
        return out;
      }
      return unclosed(a >= e || this.isComment(a, e) ? a : e);
    }
  }

  /** Records the definition; false (with the problem) when the name is already taken. */
  private define(t: Token): boolean {
    const first = this.defs.get(t.value);
    if (first !== undefined) {
      this.twice.add(t.value);
      this.error(t.from, t.to, MESSAGES.definedTwice(t.value, first, this.line), () => [
        { title: FIX_TITLES.renameSecond, edits: [{ from: t.from, to: t.to, insert: flowName(this.unique(t.value)) }] },
      ]);
      return false;
    }
    this.defs.set(t.value, this.line);
    return true;
  }

  /** An edit that deletes one bracket item and the comma that joins it to its neighbour. */
  private removeItem(item: FlowRange): { from: number; to: number; insert: string } {
    const s = this.s;
    let after = item.to;
    while (after < s.length && isWs(s.charCodeAt(after)) && s.charCodeAt(after) !== 10) after++;
    if (s.charCodeAt(after) === 44) return { from: item.from, to: this.ws(after + 1, s.length), insert: "" };
    let before = item.from;
    while (before > 0 && isWs(s.charCodeAt(before - 1)) && s.charCodeAt(before - 1) !== 10) before--;
    if (before > 0 && s.charCodeAt(before - 1) === 44) return { from: before - 1, to: item.to, insert: "" };
    return { from: item.from, to: item.to, insert: "" };
  }

  private unique(base: string): string {
    for (let n = 2; ; n++) if (!this.defs.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  private nodeKind(t: Token, attrs: Attrs | null): FlowNodeKind {
    const dk = this.kind;
    const word = attrs?.kind ?? null;
    if (!word) {
      if (dk === "dfd") {
        this.error(t.from, t.to, MESSAGES.dfdNeedsKind, () =>
          KINDS.dfd.map((k) => ({
            title: FIX_TITLES.makeKind(k),
            edits: attrs ? [{ from: attrs.from + 1, to: attrs.from + 1, insert: attrs.empty ? k : `${k}, ` }] : [{ from: t.to, to: t.to, insert: ` [${k}]` }],
          })),
        );
        return "process";
      }
      return dk === "cloud" ? "service" : "step";
    }
    if (dk === "cloud") {
      if (word.value !== "service") this.error(word.from, word.to, MESSAGES.cloudKind, () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(word)] }]);
      return "service";
    }
    const allowed: readonly string[] = dk ? KINDS[dk] : [...KINDS.dfd, ...KINDS.flow, ...KINDS.cloud];
    if (allowed.includes(word.value)) return word.value as FlowNodeKind;
    const near = nearWord(word.value, allowed);
    this.error(word.from, word.to, MESSAGES.unknownKind(word.value, dk, near), () =>
      near ? [{ title: FIX_TITLES.use(near), edits: [{ from: word.from, to: word.to, insert: near }] }] : [],
    );
    return dk === "dfd" ? "process" : "step";
  }

  private checkIcon(icon: string | undefined, range: FlowRange | undefined) {
    if (this.kind !== "cloud" || !this.icons || icon === undefined || !range || this.icons.has(icon)) return;
    let found = this.iconNear.get(icon);
    if (found === undefined && this.iconLookups + this.icons.size <= ICON_LOOKUP_BUDGET) {
      this.iconLookups += this.icons.size;
      found = nearWord(icon, this.icons);
      // A Map keeps insertion order: the first key is the oldest.
      while (this.iconNear.size >= ICON_NEAR_CAP) {
        const oldest = this.iconNear.keys().next().value;
        if (oldest === undefined) break;
        this.iconNear.delete(oldest);
      }
      this.iconNear.set(icon, found);
    }
    const near = found ?? null;
    this.problem("hint", range.from, range.to, MESSAGES.notAnIcon(icon, near), () =>
      near ? [{ title: FIX_TITLES.use(near), edits: [{ from: range.from, to: range.to, insert: near }] }] : [],
    );
  }

  private node(t: Token, attrs: Attrs | null, to: number) {
    const kind = this.nodeKind(t, attrs);
    if (!this.define(t)) return;
    const node: FlowNode = { name: t.value, kind, attrs: attrs ? attrs.attrs : {} };
    const group = this.stack[this.stack.length - 1];
    if (group) group.nodes.push(t.value);
    this.nodes.push({ node, grouped: !!group });
    this.byName.set(t.value, node);
    const key = `node:${t.value}`;
    // NODE_PARTS: name, attrs, kind.
    this.packed.set(key, [t.from, to, t.from, t.to, attrs ? attrs.from : -1, attrs ? attrs.to : -1, attrs?.kind ? attrs.kind.from : -1, attrs?.kind ? attrs.kind.to : -1]);
    if (attrs) {
      this.values.set(key, attrs.values);
      this.checkIcon(attrs.attrs.icon, attrs.values.icon);
    }
  }

  private openGroup(t: Token, attrs: Attrs | null, brace: number, e: number) {
    if (attrs && (attrs.kind || attrs.keys.some((k) => k !== "icon"))) this.error(attrs.from, attrs.to, MESSAGES.groupAttrs);
    // Past the cap the group still pairs its braces, but stays out of the tree, so nothing after recurses deep.
    const tooDeep = this.stack.length >= MAX_GROUP_DEPTH;
    if (tooDeep) this.error(t.from, t.to, MESSAGES.tooDeep);
    const fresh = !tooDeep && this.define(t);
    const g: GroupBuild = { name: t.value, nodes: [], groups: [], from: t.from, nameTo: t.to, line: this.line, repeated: !fresh };
    if (attrs?.attrs.icon !== undefined) g.icon = attrs.attrs.icon;
    if (fresh) {
      const parent = this.stack[this.stack.length - 1];
      (parent ? parent.groups : this.roots).push(g);
      const key = `group:${t.value}`;
      // GROUP_PARTS: name, attrs, open, close (filled in at the `}`).
      this.packed.set(key, [t.from, brace + 1, t.from, t.to, attrs ? attrs.from : -1, attrs ? attrs.to : -1, brace, brace + 1, -1, -1]);
      if (attrs) {
        this.values.set(key, attrs.values);
        this.checkIcon(attrs.attrs.icon, attrs.values.icon);
      }
    }
    this.stack.push(g);
    this.end(brace + 1, e);
  }

  private link(first: Token, q: number, firstArrow: FlowArrow, e: number) {
    const s = this.s;
    const names: Token[] = [first];
    const arrows: { arrow: FlowArrow; from: number; to: number }[] = [];
    let arrow: FlowArrow | null = firstArrow;
    while (arrow) {
      arrows.push({ arrow, from: q, to: q + arrow.length });
      const r = this.ws(q + arrow.length, e);
      const next = this.name(r, e);
      if (next === BAD) return;
      if (!next) {
        this.error(q, q + arrow.length, MESSAGES.noTarget(arrow));
        return;
      }
      names.push(next);
      q = this.ws(next.to, e);
      arrow = this.arrow(q, e);
    }
    let label: string | undefined;
    let labelRange: FlowRange | null = null;
    let stop = names[names.length - 1].to;
    if (q < e && s.charCodeAt(q) === 58) {
      const r = this.ws(q + 1, e);
      if (r < e && s.charCodeAt(r) === 34) {
        const ql = this.quoted(r, e);
        if (!ql) {
          this.error(r, this.trimBack(e, r), MESSAGES.textQuote);
          return;
        }
        label = ql.value;
        labelRange = { from: r, to: ql.end };
        stop = ql.end;
        this.end(ql.end, e);
      } else {
        let j = r;
        while (j < e && !this.isComment(j, e)) j++;
        const to = this.trimBack(j, r);
        if (to > r) {
          label = s.slice(r, to);
          labelRange = { from: r, to };
          stop = to;
        }
        if (j < e) this.comment(j, e);
      }
    } else {
      this.end(q, e);
    }
    const last = arrows.length - 1;
    const line = { from: first.from, to: stop };
    arrows.forEach((a, k) => {
      if (a.arrow === "..>" && this.kind !== "cloud") {
        this.error(a.from, a.to, MESSAGES.dotted, () => [{ title: FIX_TITLES.use("-->"), edits: [{ from: a.from, to: a.to, insert: "-->" }] }]);
      }
      const from = names[k];
      const to = names[k + 1];
      const link: FlowLink = { from: from.value, to: to.value, arrow: a.arrow };
      const labelled = k === last && label !== undefined;
      if (labelled) link.label = label;
      if (k > 0 && !labelled) link.chained = true;
      const i = this.links.length;
      this.links.push(link);
      this.linkLines.push(this.line);
      const lab = labelled && labelRange ? labelRange : null;
      // LINK_PARTS: fromName, toName, arrow, label, line. The undefined-name check reads the names from here.
      this.linkPacked[i] = [from.from, to.to, from.from, from.to, to.from, to.to, a.from, a.to, lab ? lab.from : -1, lab ? lab.to : -1, line.from, line.to];
    });
  }

  // ----- after the last line

  private finish() {
    const s = this.s;
    if (!this.header) {
      this.error(0, 0, MESSAGES.firstLine, () => DIAGRAM_KINDS.map((k) => ({ title: FIX_TITLES.addFirstLine(k), edits: [{ from: 0, to: 0, insert: `diagram ${k} "Untitled"\n` }] })), 1);
    }
    for (const g of this.stack) {
      const insert = s.endsWith("\n") ? "}\n" : "\n}\n";
      this.error(g.from, g.nameTo, MESSAGES.unclosed(g.name), () => [{ title: FIX_TITLES.closeGroup, edits: [{ from: s.length, to: s.length, insert }] }], g.line);
      const span = g.repeated ? undefined : this.packed.get(`group:${g.name}`);
      if (span) span[1] = this.trimBack(s.length, g.from);
    }
    this.links.forEach((l, i) => {
      const p = this.linkPacked[i];
      const line = this.linkLines[i];
      for (const end of ["from", "to"] as const) {
        const name = end === "from" ? l.from : l.to;
        if (this.defs.has(name)) continue;
        const u: Use = { name, from: p[end === "from" ? 2 : 4], to: p[end === "from" ? 3 : 5], line, end, other: end === "from" ? l.to : l.from };
        this.error(u.from, u.to, MESSAGES.notDefined(name), () => this.undefinedFixes(u), line);
      }
      if (this.kind === "flow" && l.label === undefined && this.byName.get(l.from)?.kind === "decision") {
        this.problem("hint", p[0], p[1], MESSAGES.decisionLabels, () => [], line);
      }
    });
  }

  private undefinedFixes(u: Use): QuickFix[] {
    const s = this.s;
    const kind = this.addKind(u);
    const fixes: QuickFix[] = [];
    const line = this.addLine(u.name, kind);
    fixes.push({ title: FIX_TITLES.addAs(u.name, kind), edits: [{ from: s.length, to: s.length, insert: s.length === 0 || s.endsWith("\n") ? `${line}\n` : `\n${line}` }] });
    for (const name of this.nearest(u.name).filter((n) => n !== u.other).slice(0, 2)) {
      fixes.push({ title: u.end === "to" ? FIX_TITLES.sendTo(name) : FIX_TITLES.sendFrom(name), edits: [{ from: u.from, to: u.to, insert: flowName(name) }] });
    }
    return fixes;
  }

  /**
   * The 3 names nearest a missing one, worked out once per name (a renamed node used in many links repeats it),
   * so dropping a link's other end still leaves 2. Past the comparison budget only the add fix is offered.
   */
  private nearest(name: string): string[] {
    const known = this.nearCache.get(name);
    if (known) return known;
    if (this.compareBudget < this.nodes.length) return [];
    this.compareBudget -= this.nodes.length;
    this.candidates ??= this.nodes.map(({ node }) => ({ name: node.name, lower: node.name.toLowerCase(), band: this.kind === "dfd" && node.kind === "entity" ? 1 : 0 }));
    const found = nearestNames(name, this.candidates, 3, (n) => n === name);
    this.nearCache.set(name, found);
    return found;
  }

  /** The kind a missing name is added as: in a data flow, a store when a process sends to it, an entity when it sends. */
  private addKind(u: Use): FlowNodeKind {
    if (this.kind === "cloud") return "service";
    if (this.kind !== "dfd") return "step";
    const other = this.byName.get(u.other)?.kind;
    if (other === "store" || other === "entity") return "process";
    return u.end === "to" ? "store" : "entity";
  }

  private addLine(name: string, kind: FlowNodeKind): string {
    if (kind === "service") return flowName(name);
    if (kind === "store" || kind === "process") {
      const pattern = kind === "store" ? /^D(\d+)$/ : /^(\d+)$/;
      let max = 0;
      for (const { node } of this.nodes) {
        if (node.kind !== kind) continue;
        const m = pattern.exec(node.attrs.id ?? "");
        if (m) max = Math.max(max, Number(m[1]));
      }
      return `${flowName(name)} [${kind}, id: ${kind === "store" ? "D" : ""}${max + 1}]`;
    }
    return `${flowName(name)} [${kind}]`;
  }

  private doc(kind: DiagramKind): FlowDoc {
    // Walked with a stack, never recursion: each group's own nodes, then its inner groups in order.
    const nodes: FlowNode[] = this.nodes.filter((n) => !n.grouped).map((n) => n.node);
    const groups: FlowGroup[] = [];
    const stack: { g: GroupBuild; into: FlowGroup[] }[] = this.roots.map((g) => ({ g, into: groups })).reverse();
    for (let top = stack.pop(); top; top = stack.pop()) {
      const { g, into } = top;
      for (const name of g.nodes) {
        const n = this.byName.get(name);
        if (n) nodes.push(n);
      }
      const group: FlowGroup = { name: g.name, nodes: g.nodes, groups: [] };
      if (g.icon !== undefined) group.icon = g.icon;
      into.push(group);
      for (let i = g.groups.length - 1; i >= 0; i--) stack.push({ g: g.groups[i], into: group.groups });
    }
    return { kind, title: this.title, comments: this.comments, nodes, links: this.links, groups };
  }
}

/** Parses .flow text; never throws on odd text, and reports what is wrong as problems with fixes. */
export function parseFlow(text: string, opts: FlowParseOptions = {}): FlowParse {
  return new Parser(text, opts).run();
}
