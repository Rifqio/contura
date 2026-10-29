// The .flow parser (A2): a hand-written line lexer with no regular expressions on the text, so a long line
// costs one pass. It runs in the language worker, returns problems with fixes, and never throws on odd text.
import type { QuickFix } from "../protocol";
import {
  ARROWS,
  ATTR_DIAGRAMS,
  LINE_COLOUR_DIAGRAMS,
  ATTR_KEYS,
  COLUMN_FLAGS,
  type ColumnFlag,
  DIAGRAM_KINDS,
  KIND_ALIASES,
  type DiagramKind,
  type FlowArrow,
  type FlowDoc,
  type FlowGroup,
  type FlowLink,
  type FlowNode,
  type FlowNodeKind,
  type SeqNumbering,
  flowName,
  KINDS,
  MAX_FAN_LINKS,
  MAX_GROUP_DEPTH,
  needsQuotes,
  NOTE_KINDS,
  nodeStatement,
  isStateMarker,
  PALETTE,
  STATE_END,
  STATE_START,
  stateMarkerName,
} from "./model";
import { CSS_COLOURS, isColourValue } from "./colours";
import { endsInMultiplicity, migrateOldEr, OLD_ER_ARROWS, type OldErArrow, oldErArrowAt, type OldErScan, scanOldEr } from "./erMigrate";
import { FIX_TITLES, type FlowProblem, MESSAGES, nearestNames, nearWord } from "./problems";

export type { FlowProblem } from "./problems";

export type FlowRange = { from: number; to: number };

/**
 * A source range with the ranges of its parts, one key per element.
 * - `diagram`, `kind`, `title`: plain ranges.
 * - `node:<name>`: the statement; `name`, and when it has brackets `attrs`, `kind` and `values` (each attribute's value).
 *   An ER table written as a block runs from its name to its `}`.
 * - `table:<name>`: an ER table block, through its `}`; `name`, `attrs`, `open` (`{`), `close` (`}`).
 * - `group:<name>`: through its `}`; `name`, `open` (`{`), `close` (`}`), `attrs`, `values`.
 * - `link:<i>`: from its first name to its second; `fromName`, `toName`, `arrow`, `label`, `line` (the whole statement),
 *   and `attrs` (its `[color: ..]`, step 11) on the last link of a statement that has one.
 * - `frame:<i>`: a sequence frame by its index in the doc's frames, through its `}`; `name` (the label after the kind
 *   word, empty when it has none, ending before any brackets), `attrs` (its `[color: ..]`), `values`, `open` and `close`.
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
  /** The title on the first line as read, "" when it has none; kept while the text has errors. */
  title: string;
  /** Null while the text has an error; hints alone keep it. */
  doc: FlowDoc | null;
  problems: FlowProblem[];
  /** True when an unknown icon was left without its "Did you mean" lookup (ICON_LOOKUP_BUDGET): parse again for it. */
  iconsDeferred: boolean;
  /** An ER frame still in the old form (`table.column` lines, `1--*`), which "Rewrite as table blocks" fixes. */
  readonly oldEr: boolean;
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
  /** The 1-based line each entry of `links` is written on. */
  readonly linkLines: readonly number[];
  /** The group a node or group is in: null at the top, undefined when the name is not defined. */
  parentOf(name: string): string | null | undefined;
  /** Names defined more than once (each is already a problem). */
  readonly definedTwice: ReadonlySet<string>;
  /**
   * Step 12: the lines that belong to a node besides its own (a class's member lines, an ER table's column lines),
   * with the ranges a delete, a rename or a column edit reads (see RowSpan).
   */
  rowsOf(name: string): readonly RowSpan[];
  /** Step 11: each shape's `label:` (the words it shows), by its name. */
  readonly labels: ReadonlyMap<string, string>;
  /** The kind of the node of that name, kept while the text has errors; undefined when no node has it. */
  kindOf(name: string): FlowNodeKind | undefined;
};

/**
 * A node's own extra line: the line's statement; for a class member the owner's name in it; for an ER column its
 * name, its type when written, and its flags from the first to the last.
 */
export type RowSpan = { line: FlowRange; name?: FlowRange; column?: FlowRange; type?: FlowRange; flags?: FlowRange };

// Packed spans: `[from, to, ...parts]`, each part a from/to pair, -1 where the element has no such part.
const NODE_PARTS = ["name", "attrs", "kind"] as const;
const GROUP_PARTS = ["name", "attrs", "open", "close"] as const;
const LINK_PARTS = ["fromName", "toName", "arrow", "label", "line", "attrs"] as const;
const DIRECTIVE_PARTS = ["label", "line"] as const;
type Part = (typeof NODE_PARTS)[number] | (typeof GROUP_PARTS)[number] | (typeof LINK_PARTS)[number] | (typeof DIRECTIVE_PARTS)[number];

function partsOf(key: string): readonly Part[] {
  if (key.startsWith("node:")) return NODE_PARTS;
  if (key.startsWith("group:") || key.startsWith("frame:") || key.startsWith("table:")) return GROUP_PARTS;
  if (key.startsWith("link:")) return LINK_PARTS;
  if (key.startsWith("autonumber:")) return DIRECTIVE_PARTS;
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
export const MAX_PROBLEMS = 200;

const BAD = Symbol("bad");

type Token = { value: string; from: number; to: number };
type Attrs = {
  from: number;
  /** After the `]`, or the end of what was read when it is missing. */
  to: number;
  kind: Token | null;
  attrs: Record<string, string>;
  values: Record<string, FlowRange>;
  /** Each attribute's whole item, from its key to its value's end, for a fix that removes it. */
  items: Record<string, FlowRange>;
  keys: string[];
  empty: boolean;
};
type GroupBuild = {
  name: string;
  icon?: string;
  color?: string;
  nodes: string[];
  groups: GroupBuild[];
  from: number;
  nameTo: number;
  line: number;
  /** A second group of the same name, or one nested too deep: it pairs its braces but stays out of the tree. */
  repeated: boolean;
};
/** An ER table block being read: `node` is null for a second table of a name, whose lines are read and dropped. */
type TableBuild = { name: string; node: FlowNode | null; from: number; nameTo: number; line: number };
/** One token of an ER column line: a quoted string, or a run to white space outside parentheses. */
type ColumnToken = { value: string; from: number; to: number; quoted: boolean };
/** A link end that names no shape; `list` is the comma list it was written in, when it had more than one name. */
type Use = { name: string; from: number; to: number; line: number; end: "from" | "to"; other: string; list: FlowRange | null };
/** The names at one end of an arrow, `q` after them, and a comma with no name after it (else -1). */
type EndList = { names: Token[]; q: number; comma: number };

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
  // ----- step 12 kinds
  /** Each node's own extra lines (class members). */
  private rows = new Map<string, RowSpan[]>();
  /** Sequence frames: the open ones, and those closed. */
  private frameStack: { label: string; kind: string; from: number; depth: number; at: number; nameTo: number; line: number; labelFrom: number; labelTo: number; color?: string; attrs?: FlowRange; values?: Record<string, FlowRange> }[] = [];
  private frames: NonNullable<FlowDoc["frames"]> = [];
  private openActs = new Map<string, number>();
  private activations: NonNullable<FlowDoc["activations"]> = [];
  private numbering: SeqNumbering[] = [];
  /** Timeline sections and the one items go in now. */
  private sections: string[] = [];
  private section: string | undefined;
  /** Mind map: the open path from the root down, by depth. */
  private mindPath: { name: string; depth: number }[] = [];
  private treeLinks: FlowLink[] = [];
  private notes = 0;
  /** Where `[*]` was used: as a start, an end, or both. */
  private stateMarks = { start: false, end: false };
  /** Step 11: each shape's `label:`, by its name, and the names that show each label (built when a line end needs it). */
  private labels = new Map<string, string>();
  private showing: Map<string, string[]> | null = null;
  /** Fan links by index: the from and to comma lists they were written in (from, to pairs, -1 for a single name). */
  private fanEnds = new Map<number, number[]>();
  /** The ER table block open now, and the braces of refused blocks inside it still to close. */
  private table: TableBuild | null = null;
  private innerBraces = 0;
  /** An ER frame's old forms (null when it has none), read once its kind is known. */
  private oldEr: OldErScan | null | undefined;
  /** The old-form problems so far, and which one comes first in the text: only that one offers the rewrite. */
  private oldCount = 0;
  private firstOld = -1;
  private firstOldFrom = 0;
  /** The old ER frame rewritten to table blocks, as one edit. */
  private rewrite: QuickFix["edits"][number] | null = null;

  constructor(text: string, opts: FlowParseOptions) {
    this.s = text;
    this.icons = opts.icons;
    this.iconNear = opts.iconNear ?? new Map();
  }

  private readonly iconNear: Map<string, string | null>;
  /** Icon names compared for suggestions in this parse (ICON_LOOKUP_BUDGET). */
  private iconLookups = 0;
  /** An unknown icon was past the budget, so its suggestion waits for a later parse. */
  private iconsDeferred = false;

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
      title: this.title,
      doc,
      problems,
      iconsDeferred: this.iconsDeferred,
      // A frame with no statement after its header was never scanned.
      oldEr: this.kind === "er" && (this.oldEr === undefined ? scanOldEr(this.s) : this.oldEr) !== null,
      span,
      defined: defs,
      links: this.links,
      linkLines: this.linkLines,
      parentOf,
      definedTwice: this.twice,
      rowsOf: (name: string) => this.rows.get(name) ?? [],
      labels: this.labels,
      kindOf: (name: string) => this.byName.get(name)?.kind,
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
      case 45: // -- anywhere, -> (a sequence message), or a lone -
        if (j + 1 < e && (s.charCodeAt(j + 1) === 45 || s.charCodeAt(j + 1) === 62)) return true;
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

  /**
   * A name at `p`: null when there is none, BAD when its quote never closes (the problem is recorded unless `quiet`).
   * With `atComma` a bare name also stops at a comma: one name of a link end's list.
   */
  private name(p: number, e: number, atComma = false, quiet = false): Token | null | typeof BAD {
    // A state diagram's start and end marker.
    if (this.kind === "state" && this.s.startsWith("[*]", p) && p + 3 <= e) return { value: "[*]", from: p, to: p + 3 };
    if (p < e && this.s.charCodeAt(p) === 34) {
      const q = this.quoted(p, e);
      if (!q) {
        if (!quiet) this.error(p, this.trimBack(e, p), MESSAGES.nameQuote);
        return BAD;
      }
      return { value: q.value, from: p, to: q.end };
    }
    let j = p;
    if (atComma) while (j < e && this.s.charCodeAt(j) !== 44 && !this.stopsName(j, e)) j++;
    else while (j < e && !this.stopsName(j, e)) j++;
    const to = this.trimBack(j, p);
    return to === p ? null : { value: this.s.slice(p, to), from: p, to };
  }

  private arrow(q: number, e: number): FlowArrow | OldErArrow | null {
    const s = this.s;
    if (q >= e) return null;
    if (this.kind === "er") {
      const old = oldErArrowAt(s, q, e);
      if (old) return old;
    }
    const c = s.charCodeAt(q);
    const at = (i: number) => (q + i < e ? s.charCodeAt(q + i) : -1);
    const endsAt = (i: number) => q + i >= e || isWs(s.charCodeAt(q + i));
    if (c === 62) return ">";
    if (c === 60) {
      if (at(1) === 62) return "<>";
      // <|-- inheritance (class); a lone < is an ER line (one to many).
      if (at(1) === 124) return at(2) === 45 && at(3) === 45 ? "<|--" : null;
      // `<-`, `<--` and `<=` are no arrows any kind draws: the line is left unread, as it always was.
      return at(1) === 45 || at(1) === 61 ? null : "<";
    }
    if (c === 45) {
      if (at(1) === 45 && at(2) === 62) return "-->";
      if (at(1) === 62) return "->";
      if (at(1) === 45) {
        return endsAt(2) ? "--" : null;
      }
      return endsAt(1) ? "-" : null;
    }
    // *-- (composition): the * was split off the name before it.
    if (c === 42 && at(1) === 45 && at(2) === 45) return endsAt(3) ? "*--" : null;
    if (c === 46) return q + 2 < e && s.charCodeAt(q + 1) === 46 && s.charCodeAt(q + 2) === 62 ? "..>" : null;
    return null;
  }

  /**
   * A class composition writes its `*` against the name before it (`Order *-- Line`), and the name lexer stops
   * only at the `--`: the `*` is split back off the name here.
   */
  private splitLead(t: Token, e: number): { token: Token; q: number } {
    const s = this.s;
    const q = this.ws(t.to, e);
    // An old ER line writes its near multiplicity the same way (`customers 1--* orders`).
    if (this.kind === "er" && s.charCodeAt(q) === 45 && s.charCodeAt(q + 1) === 45 && s.charCodeAt(t.from) !== 34 && endsInMultiplicity(s, t.from, t.to)) {
      const to = this.trimBack(t.to - 1, t.from);
      return { token: { value: s.slice(t.from, to), from: t.from, to }, q: t.to - 1 };
    }
    if (this.kind !== "class" || s.charCodeAt(q) !== 45 || s.charCodeAt(q + 1) !== 45) return { token: t, q };
    if (t.to - t.from < 3 || s.charCodeAt(t.to - 1) !== 42 || !isWs(s.charCodeAt(t.to - 2))) return { token: t, q };
    const to = this.trimBack(t.to - 1, t.from);
    return { token: { value: s.slice(t.from, to), from: t.from, to }, q: t.to - 1 };
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
    if (p === a && this.notAKindHeader(p, e)) return;
    if (this.kind === "er" && this.oldEr === undefined) this.oldEr = scanOldEr(this.s);
    const old = this.oldEr?.columns.get(this.line - 1);
    if (old) {
      this.oldForm(old.from, old.to, MESSAGES.oldColumn);
      const r = this.ws(old.to, e);
      if (r < e && this.isComment(r, e)) this.comment(r, e);
      return;
    }
    if (this.table) return this.columnLine(p, e);
    if (this.s.charCodeAt(p) === 125) return this.close(p, e);
    if (this.kindStatement(a, p, e)) return;
    this.nameStatement(p, e);
  }

  // ----- step 12 kinds: the statements that start with a word

  /** The lowercase word at `p` and where the text after it starts; null when no letter starts there. */
  private word(p: number, e: number): { word: string; to: number } | null {
    const s = this.s;
    let j = p;
    while (j < e) {
      const c = s.charCodeAt(j);
      if (!((c >= 97 && c <= 122) || (c >= 65 && c <= 90))) break;
      j++;
    }
    return j > p ? { word: s.slice(p, j), to: j } : null;
  }

  /** The rest of the line as text (quoted or bare, a comment after it read off); null with nothing there. */
  private restText(p: number, e: number): { value: string; from: number; to: number } | null | typeof BAD {
    const s = this.s;
    const r = this.ws(p, e);
    if (r < e && s.charCodeAt(r) === 34) {
      const q = this.quoted(r, e);
      if (!q) {
        this.error(r, this.trimBack(e, r), MESSAGES.textQuote);
        return BAD;
      }
      this.end(q.end, e);
      return { value: q.value, from: r, to: q.end };
    }
    let j = r;
    while (j < e && !this.isComment(j, e)) j++;
    const to = this.trimBack(j, r);
    if (j < e) this.comment(j, e);
    return to > r ? { value: s.slice(r, to), from: r, to } : null;
  }

  /** Handles the statements a kind starts with a word; false leaves the line to the name statement. */
  private kindStatement(lineFrom: number, p: number, e: number): boolean {
    const k = this.kind;
    if (!k) return false;
    const s = this.s;
    const w = this.word(p, e);
    const after = w ? this.ws(w.to, e) : p;
    const spaced = !!w && w.to < e && isWs(s.charCodeAt(w.to));
    // note: text (the shared note).
    if (w && w.word === "note" && NOTE_KINDS.has(k) && after < e && s.charCodeAt(after) === 58) {
      const text = this.restText(after + 1, e);
      if (text === BAD) return true;
      const name = `Note ${++this.notes}`;
      const range = text ?? { from: after + 1, to: after + 1 };
      this.defs.set(name, this.line);
      this.pushNode({ name, kind: "note", attrs: {}, text: text?.value ?? "" }, { from: p, to: range.to }, range);
      return true;
    }
    if (k === "sequence" && w && w.word === "autonumber" && (w.to >= e || isWs(s.charCodeAt(w.to)) || this.isComment(w.to, e) || s.charCodeAt(w.to) === 58)) return this.autonumber(p, w.to, e);
    if (k === "sequence" && w && spaced) {
      if (w.word === "participant" || w.word === "actor") return this.declared(p, after, e, w.word);
      if (w.word === "activate" || w.word === "deactivate") {
        const t = this.name(after, e);
        if (t === BAD) return true;
        if (!t) {
          this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
          return true;
        }
        if (w.word === "activate") this.openActs.set(t.value, this.links.length);
        else {
          const from = this.openActs.get(t.value);
          if (from !== undefined) {
            this.openActs.delete(t.value);
            this.activations.push({ name: t.value, from, to: this.links.length - 1 });
          }
        }
        this.end(t.to, e);
        return true;
      }
      if (w.word === "loop" || w.word === "alt" || w.word === "opt" || w.word === "par" || w.word === "critical") {
        let j = after;
        while (j < e && s.charCodeAt(j) !== 123 && !this.isComment(j, e)) j++;
        if (j >= e || s.charCodeAt(j) !== 123) {
          this.error(p, this.lineEnd(p, e), MESSAGES.frameNeedsBrace);
          return true;
        }
        let labelTo = this.trimBack(j, after);
        // A trailing [..] is the block's attributes only when every key in it is a known one; a UML guard stays text.
        const b = this.trailingAttrs(after, labelTo);
        const attrs = b >= 0 ? this.attrs(b, labelTo) : null;
        if (attrs) labelTo = this.trimBack(b, after);
        const label = s.slice(after, labelTo).trim();
        if (attrs) this.blockAttrs(attrs);
        this.frameStack.push({ label: label ? `${w.word} ${label}` : w.word, kind: w.word, from: this.links.length, depth: this.frameStack.length, at: p, nameTo: j, line: this.line, labelFrom: after, labelTo, color: attrs?.attrs.color, attrs: attrs ? { from: attrs.from, to: attrs.to } : undefined, values: attrs?.values });
        this.end(j + 1, e);
        return true;
      }
    }
    if (k === "er" && w && spaced && w.word === "group") return this.erGroup(p, after, e);
    if (k === "class" && w && spaced && (w.word === "class" || w.word === "interface" || w.word === "enum")) return this.declared(p, after, e, w.word);
    if (k === "mindmap" && w && spaced && w.word === "root") {
      if (!this.declared(p, after, e, "root")) return true;
      const root = [...this.defs.keys()].pop();
      if (root !== undefined) this.mindPath = [{ name: root, depth: 0 }];
      return true;
    }
    if (k === "timeline") {
      if (w && spaced && w.word === "section") {
        const text = this.restText(after, e);
        if (text && text !== BAD) {
          this.section = text.value;
          this.sections.push(text.value);
        } else if (!text) this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
        return true;
      }
      if (w && spaced && w.word === "milestone") return this.declared(p, after, e, "milestone");
      return this.dated(p, e);
    }
    void lineFrom;
    return false;
  }

  /** An `autonumber` line in a sequence: bare, `off` or a number; with an arrow or colon it is a name, quoted by the fix. */
  private autonumber(p: number, wordTo: number, e: number): boolean {
    const s = this.s;
    const at = this.ws(wordTo, e);
    const stop = this.trimBack(this.lineEnd(at, e), at);
    const c = at < e ? s.charCodeAt(at) : 0;
    const c2 = at + 1 < e ? s.charCodeAt(at + 1) : 0;
    if (c === 58 || c === 62 || c === 60 || (c === 45 && (c2 === 45 || c2 === 62)) || (c === 46 && c2 === 46)) {
      this.error(p, stop, MESSAGES.autonumberName, () => [{ title: FIX_TITLES.use('"autonumber"'), edits: [{ from: p, to: wordTo, insert: '"autonumber"' }] }]);
      return true;
    }
    const arg = s.slice(at, stop);
    const from = this.links.length;
    if (stop > at && !/^(off|0|[1-9]\d{0,5})$/.test(arg)) {
      this.error(at, stop, MESSAGES.autonumberArg, () => [{ title: FIX_TITLES.remove, edits: [{ from: wordTo, to: stop, insert: "" }] }]);
      return true;
    }
    const d: SeqNumbering = { from };
    if (arg === "off") d.off = true;
    else if (stop > at) d.start = Number(arg);
    const to = stop > at ? stop : wordTo;
    const lineTo = this.trimBack(e, p);
    this.packed.set(`autonumber:${this.numbering.length}`, [p, to, stop > at ? at : -1, stop > at ? stop : -1, p, lineTo]);
    this.numbering.push(d);
    this.end(to, e);
    return true;
  }

  /** A node declared by its leading word: `participant App`, `class Invoice`, `milestone v1.0`, `root Plan`. */
  private declared(p: number, at: number, e: number, kind: FlowNodeKind): boolean {
    const t = this.name(at, e);
    if (t === BAD) return true;
    if (!t) {
      this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
      return true;
    }
    if (!this.define(t)) return true;
    const node: FlowNode = { name: t.value, kind, attrs: {} };
    if (kind === "root") node.depth = 0;
    if (this.kind === "timeline" && this.section !== undefined) node.section = this.section;
    const q = this.ws(t.to, e);
    if ((kind === "participant" || kind === "actor") && q < e && this.s.charCodeAt(q) === 91) {
      const attrs = this.participantAttrs(this.attrs(q, e));
      node.attrs = attrs.attrs;
      this.pushNode(node, { from: p, to: attrs.to }, t);
      const key = `node:${t.value}`;
      this.packed.set(key, [p, attrs.to, t.from, t.to, attrs.from, attrs.to, -1, -1]);
      this.values.set(key, attrs.values);
      this.checkIcon(attrs.attrs.icon, attrs.values.icon);
      this.end(attrs.to, e);
      return true;
    }
    this.pushNode(node, { from: p, to: t.to }, t);
    this.end(t.to, e);
    return true;
  }

  /** A participant's brackets take an icon, a label and a colour; a kind word, an id or a table is an error. */
  private participantAttrs(attrs: Attrs): Attrs {
    const bad = (r: FlowRange) => this.error(r.from, r.to, MESSAGES.participantAttrs, () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(r)] }]);
    if (attrs.kind) bad(attrs.kind);
    for (const key of ["id", "table"]) {
      if (!attrs.items[key]) continue;
      bad(attrs.items[key]);
      delete attrs.attrs[key];
      delete attrs.values[key];
      attrs.keys = attrs.keys.filter((k) => k !== key);
    }
    this.checkColour(attrs.attrs.color, attrs.values.color);
    return attrs;
  }

  /** A timeline item: `2026-10-19: Docs ready`, or a period `2026-09 to 2026-10: Data transfer`. */
  private dated(p: number, e: number): boolean {
    const s = this.s;
    const dateAt = (q: number): { value: string; to: number } | null => {
      let j = q;
      while (j < e && ((s.charCodeAt(j) >= 48 && s.charCodeAt(j) <= 57) || s.charCodeAt(j) === 45)) j++;
      return j > q ? { value: s.slice(q, j), to: j } : null;
    };
    const first = dateAt(p);
    if (!first) {
      this.error(p, this.lineEnd(p, e), MESSAGES.timelineLine);
      return true;
    }
    const good = (d: string) => /^\d{4}(-\d{2}(-\d{2})?)?$/.test(d);
    if (!good(first.value)) {
      this.error(p, first.to, MESSAGES.badDate);
      return true;
    }
    let q = this.ws(first.to, e);
    let until: string | undefined;
    if (s.startsWith("to", q) && q + 2 < e && isWs(s.charCodeAt(q + 2))) {
      const r = this.ws(q + 2, e);
      const second = dateAt(r);
      if (!second || !good(second.value)) {
        this.error(r, second ? second.to : this.lineEnd(r, e), MESSAGES.badDate);
        return true;
      }
      until = second.value;
      q = this.ws(second.to, e);
    }
    if (q >= e || s.charCodeAt(q) !== 58) {
      this.error(p, this.lineEnd(p, e), MESSAGES.needsColon);
      return true;
    }
    const t = this.name(this.ws(q + 1, e), e);
    if (t === BAD) return true;
    if (!t) {
      this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
      return true;
    }
    if (!this.define(t)) return true;
    const node: FlowNode = { name: t.value, kind: until ? "period" : "event", attrs: {}, date: first.value };
    if (until) node.until = until;
    if (this.section !== undefined) node.section = this.section;
    this.pushNode(node, { from: p, to: t.to }, t);
    this.end(t.to, e);
    return true;
  }

  /** Adds a node made by a step 12 statement, with its span (NODE_PARTS: name, attrs, kind). */
  private pushNode(node: FlowNode, span: FlowRange, name: FlowRange) {
    const group = this.stack[this.stack.length - 1];
    if (group) group.nodes.push(node.name);
    this.nodes.push({ node, grouped: !!group });
    this.byName.set(node.name, node);
    this.packed.set(`node:${node.name}`, [span.from, span.to, name.from, name.to, -1, -1, -1, -1]);
  }

  /** An extra line of a node (a class member, an ER column with its flags). */
  private addRow(owner: string, text: string, span: RowSpan, flags?: ColumnFlag[], comment: string | null = null) {
    const n = this.byName.get(owner);
    if (!n) return;
    const rows = (n.rows ??= []);
    rows.push(text);
    // Flags and comments only once a column has some: the rows before it get none.
    if (flags && flags.length > 0 && !n.rowFlags) n.rowFlags = rows.slice(0, -1).map(() => []);
    if (n.rowFlags) n.rowFlags.push(flags ?? []);
    if (comment !== null && !n.rowComments) n.rowComments = rows.slice(0, -1).map(() => undefined);
    if (n.rowComments) n.rowComments.push(comment ?? undefined);
    const list = this.rows.get(owner) ?? [];
    list.push(span);
    this.rows.set(owner, list);
  }

  // ----- ER tables

  /** An old-form problem; the first in the text offers "Rewrite as table blocks" after its own fixes. */
  private oldForm(from: number, to: number, message: string, own: () => QuickFix[] = () => []) {
    const id = this.oldCount++;
    if (this.firstOld < 0 || from < this.firstOldFrom) {
      this.firstOld = id;
      this.firstOldFrom = from;
    }
    this.error(from, to, message, () => (this.firstOld === id ? [...own(), this.rewriteFix()] : own()));
  }

  /** An old `Billing {` group: read as a group, with the problem that it now starts with the word group. */
  private oldGroup(t: Token, attrs: Attrs | null, brace: number, e: number) {
    this.oldForm(t.from, this.lineEnd(t.from, e), MESSAGES.oldGroup);
    this.openGroup(t, attrs, brace, e);
  }

  /** "Rewrite as table blocks": one edit over the span the rewrite changes, computed once per parse. */
  private rewriteFix(): QuickFix {
    if (!this.rewrite) {
      const s = this.s;
      const to = migrateOldEr(s, this.oldEr ?? null);
      let a = 0;
      const most = Math.min(s.length, to.length);
      while (a < most && s.charCodeAt(a) === to.charCodeAt(a)) a++;
      let b = 0;
      while (b < most - a && s.charCodeAt(s.length - 1 - b) === to.charCodeAt(to.length - 1 - b)) b++;
      this.rewrite = { from: a, to: s.length - b, insert: to.slice(a, to.length - b) };
    }
    return { title: FIX_TITLES.rewriteBlocks, edits: [{ ...this.rewrite }] };
  }

  /** `group Billing [icon: .., color: ..] {` in an ER diagram; false leaves a line with no `{` to the name statement. */
  private erGroup(p: number, at: number, e: number): boolean {
    const s = this.s;
    const stop = this.lineEnd(p, e);
    if (stop <= at || s.charCodeAt(stop - 1) !== 123) return false;
    const t = this.name(at, e);
    if (t === BAD) return true;
    if (!t) return false;
    let q = this.ws(t.to, e);
    let attrs: Attrs | null = null;
    if (q < e && s.charCodeAt(q) === 91) {
      attrs = this.attrs(q, e);
      q = this.ws(attrs.to, e);
    }
    if (q >= e || s.charCodeAt(q) !== 123) {
      this.end(q, e);
      return true;
    }
    this.openGroup(t, attrs, q, e, p);
    return true;
  }

  /** `orders [weak, icon: .., label: .., color: ..] {`: a table whose lines are its columns until its `}`. */
  private openTable(t: Token, attrs: Attrs | null, brace: number, e: number) {
    const s = this.s;
    const fresh = this.node(t, attrs, brace + 1);
    this.table = { name: t.value, node: fresh ? (this.byName.get(t.value) ?? null) : null, from: t.from, nameTo: t.to, line: this.line };
    if (fresh) {
      // GROUP_PARTS: name, attrs, open, close (filled in at the `}`).
      this.packed.set(`table:${t.value}`, [t.from, brace + 1, t.from, t.to, attrs ? attrs.from : -1, attrs ? attrs.to : -1, brace, brace + 1, -1, -1]);
    }
    // `orders {}`: a table with no columns, closed on its own line.
    const r = this.ws(brace + 1, e);
    if (r < e && s.charCodeAt(r) === 125) {
      this.closeTable(r);
      this.end(r + 1, e);
      return;
    }
    this.end(brace + 1, e);
  }

  private closeTable(p: number) {
    const t = this.table;
    this.table = null;
    if (!t?.node) return;
    const node = this.packed.get(`node:${t.name}`);
    if (node) node[1] = p + 1;
    const table = this.packed.get(`table:${t.name}`);
    if (table) {
      table[1] = p + 1;
      table[8] = p;
      table[9] = p + 1;
    }
  }

  /**
   * The tokens of a column line and the comment after them (null when none); null when a quote never closes (the
   * problem is recorded). An open `(` is a problem; its token then also ends before a flag word, so the flags are read.
   */
  private columnTokens(p: number, e: number): { tokens: ColumnToken[]; comment: string | null } | null {
    const s = this.s;
    const tokens: ColumnToken[] = [];
    let j = this.ws(p, e);
    while (j < e && !this.isComment(j, e)) {
      if (s.charCodeAt(j) === 34) {
        const q = this.quoted(j, e);
        if (!q) {
          this.error(j, this.trimBack(e, j), MESSAGES.textQuote);
          return null;
        }
        tokens.push({ value: q.value, from: j, to: q.end, quoted: true });
        j = this.ws(q.end, e);
        continue;
      }
      let k = j;
      let depth = 0;
      let openAt = -1;
      for (; k < e; k++) {
        const c = s.charCodeAt(k);
        if (c === 40) {
          if (depth++ === 0) openAt = k;
        } else if (c === 41) depth = Math.max(0, depth - 1);
        else if (depth > 0 && (c === 39 || c === 34)) {
          // A quoted value inside parentheses (`enum('does not apply')`) is part of the type, whatever it holds.
          const close = s.indexOf(String.fromCharCode(c), k + 1);
          if (close >= 0 && close < e) k = close;
        } else if (this.isComment(k, e)) break;
        else if (isWs(c) && (depth === 0 || this.flagWordAt(this.ws(k, e), e))) break;
      }
      if (depth > 0) this.error(openAt, openAt + 1, MESSAGES.openParen);
      tokens.push({ value: s.slice(j, k), from: j, to: k, quoted: false });
      j = this.ws(k, e);
    }
    return { tokens, comment: j < e ? s.slice(j + 2, e).trim() : null };
  }

  /**
   * True when a flag's first word (`pk`, `not`, `unique`, any case) stands alone at `p`; one followed by `)` is a
   * value inside the type (`set(a, pk )`).
   */
  private flagWordAt(p: number, e: number): boolean {
    const w = this.word(p, e);
    if (!w || !(w.to >= e || isWs(this.s.charCodeAt(w.to)) || this.isComment(w.to, e))) return false;
    const after = this.ws(w.to, e);
    if (after < e && this.s.charCodeAt(after) === 41) return false;
    const lower = w.word.toLowerCase();
    return lower === "pk" || lower === "not" || lower === "unique";
  }

  /** A line inside a table block: its `}`, or a column `name type flags`. */
  private columnLine(p: number, e: number) {
    const s = this.s;
    const table = this.table!;
    if (s.charCodeAt(p) === 125) {
      if (this.innerBraces > 0) this.innerBraces--;
      else this.closeTable(p);
      this.end(p + 1, e);
      return;
    }
    const read = this.columnTokens(p, e);
    if (!read || read.tokens.length === 0) return;
    const { tokens, comment } = read;
    const last = tokens[tokens.length - 1];
    if (!last.quoted && last.value.endsWith("{")) {
      // A block inside a table: refused once, its braces paired so the table still closes at its own `}`.
      if (this.innerBraces === 0 && table.node) this.error(p, last.to, MESSAGES.tableInTable);
      this.innerBraces++;
      return;
    }
    if (this.innerBraces > 0 || !table.node) return;
    const name = tokens[0];
    if (name.quoted || needsQuotes(name.value)) {
      this.error(name.from, name.to, MESSAGES.columnName);
      return;
    }
    const isFlagStart = (t: ColumnToken) => {
      if (t.quoted) return false;
      const w = t.value.toLowerCase();
      return w === "pk" || w === "unique" || w === "not";
    };
    let i = 1;
    let type: ColumnToken | null = null;
    if (i < tokens.length && !isFlagStart(tokens[i])) type = tokens[i++];
    const found = new Set<ColumnFlag>();
    const flagsFrom = i < tokens.length ? tokens[i].from : -1;
    for (; i < tokens.length; i++) {
      const t = tokens[i];
      const w = t.value.toLowerCase();
      if (!t.quoted && (w === "pk" || w === "unique")) {
        found.add(w);
        continue;
      }
      let word = t.value;
      let to = t.to;
      if (!t.quoted && w === "not" && i + 1 < tokens.length) {
        const next = tokens[i + 1];
        if (!next.quoted && next.value.toLowerCase() === "null") {
          found.add("not null");
          i++;
          continue;
        }
        // `not nul`: the two words are one flag misspelt, unless the second is a flag of its own.
        if (!isFlagStart(next) && !next.quoted) {
          word = `${t.value} ${next.value}`;
          to = next.to;
          i++;
        }
      }
      // A quoted flag and a lone `not` are a flag written wrong: the fix writes it plainly.
      const exact = (COLUMN_FLAGS as readonly string[]).includes(w) ? (w as ColumnFlag) : null;
      const near = exact ?? (word.toLowerCase() === "not" ? "not null" : nearWord(word.toLowerCase(), COLUMN_FLAGS));
      const at = t.from;
      this.error(at, to, MESSAGES.unknownFlag(word, near), () => (near ? [{ title: FIX_TITLES.use(near), edits: [{ from: at, to, insert: near }] }] : []));
    }
    const typeText = type && type.value !== "" ? type.value : null;
    const span: RowSpan = { line: { from: name.from, to: last.to }, column: { from: name.from, to: name.to } };
    if (type) span.type = { from: type.from, to: type.to };
    if (flagsFrom >= 0) span.flags = { from: flagsFrom, to: last.to };
    this.addRow(table.name, typeText === null ? name.value : `${name.value} ${typeText}`, span, COLUMN_FLAGS.filter((f) => found.has(f)), comment);
  }

  /**
   * A line end `table.column` that names no node of its own is that table's column, once every line is read (a line
   * may come before its tables). The table is the longest part before a dot that names one, so `sales.orders.id`
   * is the column id of a table `sales.orders`. The end becomes the table and the column goes beside it; a column the
   * table does not have is a problem. A quoted end is a name, never a column.
   */
  private columnEnds() {
    const s = this.s;
    const told = new Set<number>();
    // Each table's column names, built on first use.
    const columns = new Map<string, Set<string>>();
    const columnsOf = (table: string, node: FlowNode) => {
      let set = columns.get(table);
      if (!set) {
        set = new Set((node.rows ?? []).map(columnName));
        columns.set(table, set);
      }
      return set;
    };
    this.links.forEach((l, i) => {
      const p = this.linkPacked[i];
      for (const end of ["from", "to"] as const) {
        const name = end === "from" ? l.from : l.to;
        const at = p[end === "from" ? 2 : 4];
        if (this.defs.has(name) || s.charCodeAt(at) === 34) continue;
        let table = "";
        let node: FlowNode | undefined;
        for (let dot = name.lastIndexOf("."); dot > 0; dot = name.lastIndexOf(".", dot - 1)) {
          const found = this.byName.get(name.slice(0, dot));
          if (found && (found.kind === "entity" || found.kind === "weak")) {
            table = name.slice(0, dot);
            node = found;
            break;
          }
        }
        if (!node) continue;
        const column = name.slice(table.length + 1);
        // A fan line repeats an end in several links: its problem is told once.
        // An old frame's columns are not read yet: the rewrite puts them in their tables.
        if (!this.oldEr && !columnsOf(table, node).has(column) && !told.has(at)) {
          told.add(at);
          this.error(at, p[end === "from" ? 3 : 5], MESSAGES.noColumn(table, column), () => [], this.linkLines[i]);
        }
        if (end === "from") {
          l.from = table;
          l.fromColumn = column;
        } else {
          l.to = table;
          l.toColumn = column;
        }
      }
    });
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
    } else if (r > q && this.aliasEnd(q, r, e) !== null) {
      // Another name for a kind (`flowchart`, `mind map`) is said as it is on a later line, with its one fix.
      r = this.aliasEnd(q, r, e)!;
      const said = s.slice(q, r);
      const use = KIND_ALIASES.get(said.toLowerCase().replace(/\s+/g, " "))!;
      this.error(q, r, MESSAGES.notAKind(said, use), () => [{ title: FIX_TITLES.use(use), edits: [{ from: q, to: r, insert: use }] }]);
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

  /**
   * A line at column 0 shaped like a header whose word is no diagram kind (`diagram flowchart "Checkout"`). Only a known
   * kind starts a frame, so this line sits in the frame before it: it gets one problem, a fix when the word is another
   * name for a kind, and nothing else. Another name for a kind counts before a quoted title, a comment or the line end;
   * any other word only before a quoted title, so shapes named `diagram cleanup` or `diagram store [step]` stay shapes.
   */
  private notAKindHeader(p: number, e: number): boolean {
    const s = this.s;
    if (!s.startsWith("diagram", p) || p + 7 >= e || !isWs(s.charCodeAt(p + 7))) return false;
    const q = this.ws(p + 7, e);
    const wordEnd = (from: number) => {
      let j = from;
      while (j < e && /[A-Za-z0-9_-]/.test(s[j])) j++;
      return j;
    };
    let r = wordEnd(q);
    if (r === q) return false;
    let word = s.slice(q, r);
    // "mind map" is the one alias of two words.
    if (word.toLowerCase() === "mind") {
      const m = this.ws(r, e);
      const n = wordEnd(m);
      if (m > r && s.slice(m, n).toLowerCase() === "map") {
        r = n;
        word = s.slice(q, r);
      }
    }
    if ((DIAGRAM_KINDS as readonly string[]).includes(word)) return false;
    const use = KIND_ALIASES.get(word.toLowerCase().replace(/\s+/g, " ")) ?? null;
    if (r < e && !isWs(s.charCodeAt(r)) && s.charCodeAt(r) !== 34) return false;
    const t = this.ws(r, e);
    const titled = t < e && s.charCodeAt(t) === 34;
    if (use ? !titled && t < e && !this.isComment(t, e) : !titled) return false;
    const fixes = use ? () => [{ title: FIX_TITLES.use(use), edits: [{ from: q, to: r, insert: use }] }] : undefined;
    this.error(q, r, MESSAGES.notAKind(word, use), fixes);
    return true;
  }

  /**
   * Where a first line's kind word `s[q, r)` ends when it is another name for a kind, taking `map` after `mind`; null
   * when it is no such name.
   */
  private aliasEnd(q: number, r: number, e: number): number | null {
    const s = this.s;
    const word = s.slice(q, r).toLowerCase();
    if (word === "mind") {
      const m = this.ws(r, e);
      if (m > r && s.slice(m, m + 3).toLowerCase() === "map" && (m + 3 >= e || isWs(s.charCodeAt(m + 3)) || s.charCodeAt(m + 3) === 34)) return m + 3;
    }
    return KIND_ALIASES.has(word) ? r : null;
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
    const f = this.kind === "sequence" ? this.frameStack.pop() : undefined;
    if (f) {
      // GROUP_PARTS for `frame:<i>` (its index in the doc's frames): the label after the kind word, the `{`, the `}`.
      this.packed.set(`frame:${this.frames.length}`, [f.at, p + 1, f.labelFrom, f.labelTo, f.attrs ? f.attrs.from : -1, f.attrs ? f.attrs.to : -1, f.nameTo, f.nameTo + 1, p, p + 1]);
      if (f.values) this.values.set(`frame:${this.frames.length}`, f.values);
      this.frames.push({ label: f.label, kind: f.kind, from: f.from, to: this.links.length - 1, depth: f.depth, ...(f.color !== undefined ? { color: f.color } : {}) });
      this.end(p + 1, e);
      return;
    }
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

  /** The comma list of names at `p` (one end of an arrow); null when no name starts there. */
  private endList(p: number, e: number, quiet: boolean): EndList | null | typeof BAD {
    const s = this.s;
    const first = this.name(p, e, true, quiet);
    if (first === BAD || !first) return first;
    const names = [first];
    let comma = -1;
    for (let c = this.ws(first.to, e); c < e && s.charCodeAt(c) === 44; ) {
      const next = this.name(this.ws(c + 1, e), e, true, quiet);
      if (next === BAD) return BAD;
      if (!next) {
        comma = c;
        break;
      }
      names.push(next);
      c = this.ws(next.to, e);
    }
    const split = this.splitLead(names[names.length - 1], e);
    names[names.length - 1] = split.token;
    return { names, q: comma >= 0 ? comma : split.q, comma };
  }

  private nameStatement(p: number, e: number) {
    // One look-ahead: a comma list followed by an arrow is a link line. Any other line is read again from its start,
    // where a bare comma is part of a node's name (old files); a line with no comma is never read twice.
    const head = this.endList(p, e, true);
    if (head && head !== BAD && head.comma < 0) {
      const arrow = this.arrow(head.q, e);
      if (arrow) return this.link(head.names, head.q, arrow, e);
    }
    let first: Token;
    let q: number;
    if (head && head !== BAD && head.comma < 0 && head.names.length === 1) {
      first = head.names[0];
      q = head.q;
    } else {
      const named = this.name(p, e);
      if (named === BAD) return;
      if (!named) {
        this.error(p, this.lineEnd(p, e), MESSAGES.needsName);
        return;
      }
      ({ token: first, q } = this.splitLead(named, e));
      const arrow = this.arrow(q, e);
      if (arrow) {
        // `A, > B` and `A,, B > C`: a comma with no name after it; `, A > B`: one with no name before it.
        const comma = head && head !== BAD ? head.comma : -1;
        if (comma >= 0) this.error(comma, comma + 1, MESSAGES.listName);
        else if (!head && this.s.charCodeAt(p) === 44) this.error(p, p + 1, MESSAGES.listNameBefore);
        else this.link([first], q, arrow, e);
        return;
      }
    }
    const c = q < e ? this.s.charCodeAt(q) : -1;
    // A class member: `Invoice : + send()`.
    if (this.kind === "class" && c === 58) {
      const text = this.restText(q + 1, e);
      if (text === BAD) return;
      const owner = this.byName.get(first.value);
      if (!owner || !(owner.kind === "class" || owner.kind === "interface" || owner.kind === "enum")) {
        this.error(first.from, first.to, MESSAGES.noClass(first.value));
        return;
      }
      this.addRow(first.value, text?.value ?? "", { line: { from: first.from, to: text?.to ?? q + 1 }, name: first });
      return;
    }
    if (this.kind === "timeline") {
      this.error(p, this.lineEnd(p, e), MESSAGES.timelineLine);
      return;
    }
    if (c === 91) {
      const attrs = this.attrs(q, e);
      const r = this.ws(attrs.to, e);
      if (r < e && this.s.charCodeAt(r) === 123) return this.kind !== "er" ? this.openGroup(first, attrs, r, e) : this.oldEr?.groups.has(this.line - 1) ? this.oldGroup(first, attrs, r, e) : this.openTable(first, attrs, r, e);
      this.node(first, attrs, attrs.to);
      if (attrs.to > q && this.s.charCodeAt(attrs.to - 1) === 93) this.end(attrs.to, e);
      return;
    }
    if (c === 123) return this.kind !== "er" ? this.openGroup(first, null, q, e) : this.oldEr?.groups.has(this.line - 1) ? this.oldGroup(first, null, q, e) : this.openTable(first, null, q, e);
    this.node(first, null, first.to);
    this.end(q, e);
  }

  private attrs(q: number, e: number): Attrs {
    const s = this.s;
    const out: Attrs = { from: q, to: q + 1, kind: null, attrs: {}, values: {}, items: {}, keys: [], empty: true };
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
            out.items[word] = { from: j, to: range.to };
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
      if (dk === "cloud") return "service";
      if (dk === "er") return "entity";
      if (dk === "state") return "state";
      if (dk === "sequence") return "participant";
      if (dk === "class") return "class";
      if (dk === "mindmap") return "topic";
      return "step";
    }
    if (dk && KINDS[dk].length === 0) {
      this.error(word.from, word.to, MESSAGES.bracketKinds(dk), () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(word)] }]);
      return dk === "sequence" ? "participant" : dk === "class" ? "class" : dk === "mindmap" ? "topic" : "event";
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
    return dk === "dfd" ? "process" : dk === "er" ? "entity" : "step";
  }

  private checkIcon(icon: string | undefined, range: FlowRange | undefined) {
    if ((this.kind !== "cloud" && this.kind !== "sequence") || !this.icons || icon === undefined || !range || this.icons.has(icon)) return;
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
    } else if (found === undefined && this.icons.size <= ICON_LOOKUP_BUDGET) {
      // A later parse can look it up; a list past the whole budget never can.
      this.iconsDeferred = true;
    }
    const near = found ?? null;
    this.problem("hint", range.from, range.to, MESSAGES.notAnIcon(icon, near), () =>
      near ? [{ title: FIX_TITLES.use(near), edits: [{ from: range.from, to: range.to, insert: near }] }] : [],
    );
  }

  /** A `color:` that is no preset, CSS colour name or hex is a hint with the nearest name and the six presets. */
  private checkColour(value: string | undefined, range: FlowRange | undefined) {
    if (value === undefined || !range || isColourValue(value)) return;
    const near = nearWord(value.trim(), [...PALETTE, ...CSS_COLOURS.keys()]);
    this.problem("hint", range.from, range.to, MESSAGES.notAColour(value, near), () =>
      (near ? [near, ...PALETTE] : [...PALETTE]).map((c) => ({ title: FIX_TITLES.use(c), edits: [{ from: range.from, to: range.to, insert: c }] })),
    );
  }

  /** Step 11: `label:` and `color:` on a shape, where its kind takes them. */
  private checkShapeAttrs(attrs: Attrs) {
    const dk = this.kind;
    for (const key of ["label", "color"]) {
      const item = attrs.items[key];
      if (!item) continue;
      // A sequence takes them only on `participant Name [..]`, not on a bare `Name [..]`.
      if (dk && (!ATTR_DIAGRAMS.has(dk) || dk === "sequence")) this.error(item.from, item.to, MESSAGES.noAttrHere(key, dk), () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(item)] }]);
    }
    this.checkColour(attrs.attrs.color, attrs.values.color);
  }

  /** Adds a node from its statement; false when its name is already taken (the problem is recorded). */
  private node(t: Token, attrs: Attrs | null, to: number): boolean {
    const kind = this.nodeKind(t, attrs);
    if (attrs) this.checkShapeAttrs(attrs);
    if (!this.define(t)) return false;
    if (attrs?.attrs.label !== undefined) this.labels.set(t.value, attrs.attrs.label);
    const node: FlowNode = { name: t.value, kind, attrs: attrs ? attrs.attrs : {} };
    if (this.kind === "mindmap") this.mindTopic(node, t.from);
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
    return true;
  }

  /** A mind map topic: its depth from the indent (two spaces a level), and the branch from its parent. */
  private mindTopic(node: FlowNode, at: number) {
    const s = this.s;
    let indent = 0;
    for (let j = this.lineStartOf(at); j < at; j++) indent += s.charCodeAt(j) === 9 ? 2 : 1;
    const depth = Math.max(1, Math.floor(indent / 2));
    node.depth = depth;
    while (this.mindPath.length && this.mindPath[this.mindPath.length - 1].depth >= depth) this.mindPath.pop();
    const parent = this.mindPath[this.mindPath.length - 1];
    if (parent) this.treeLinks.push({ from: parent.name, to: node.name, arrow: "-", tree: true });
    this.mindPath.push({ name: node.name, depth });
  }

  /** A group; `start` is where its statement starts when a word comes before its name (`group Billing {`). */
  private openGroup(t: Token, attrs: Attrs | null, brace: number, e: number, start = t.from) {
    // A group takes an icon and a colour (step 11); its name stays unique, so no label.
    if (attrs && (attrs.kind || attrs.keys.some((k) => k !== "icon" && k !== "color"))) this.error(attrs.from, attrs.to, MESSAGES.groupAttrs);
    if (attrs) this.checkColour(attrs.attrs.color, attrs.values.color);
    // Past the cap the group still pairs its braces, but stays out of the tree, so nothing after recurses deep.
    const tooDeep = this.stack.length >= MAX_GROUP_DEPTH;
    if (tooDeep) this.error(t.from, t.to, MESSAGES.tooDeep);
    const fresh = !tooDeep && this.define(t);
    const g: GroupBuild = { name: t.value, nodes: [], groups: [], from: start, nameTo: t.to, line: this.line, repeated: !fresh };
    if (attrs?.attrs.icon !== undefined) g.icon = attrs.attrs.icon;
    if (attrs?.attrs.color !== undefined) g.color = attrs.attrs.color;
    if (fresh) {
      const parent = this.stack[this.stack.length - 1];
      (parent ? parent.groups : this.roots).push(g);
      const key = `group:${t.value}`;
      // GROUP_PARTS: name, attrs, open, close (filled in at the `}`).
      this.packed.set(key, [start, brace + 1, t.from, t.to, attrs ? attrs.from : -1, attrs ? attrs.to : -1, brace, brace + 1, -1, -1]);
      if (attrs) {
        this.values.set(key, attrs.values);
        this.checkIcon(attrs.attrs.icon, attrs.values.icon);
      }
    }
    this.stack.push(g);
    this.end(brace + 1, e);
  }

  /** A link statement: `head` is the comma list before the first arrow; every list after an arrow is read here. */
  private link(head: Token[], q: number, firstArrow: FlowArrow | OldErArrow, e: number) {
    const s = this.s;
    const lists: Token[][] = [head];
    const arrows: { arrow: FlowArrow | OldErArrow; from: number; to: number }[] = [];
    let arrow: FlowArrow | OldErArrow | null = firstArrow;
    while (arrow) {
      arrows.push({ arrow, from: q, to: q + arrow.length });
      const r = this.ws(q + arrow.length, e);
      const read = this.endList(r, e, false);
      if (read === BAD) return;
      if (!read) {
        this.error(q, q + arrow.length, MESSAGES.noTarget(arrow));
        return;
      }
      if (read.comma >= 0) {
        this.error(read.comma, read.comma + 1, MESSAGES.listName);
        return;
      }
      lists.push(read.names);
      q = read.q;
      arrow = this.arrow(q, e);
    }
    const lastList = lists[lists.length - 1];
    let label: string | undefined;
    let labelRange: FlowRange | null = null;
    let stop = lastList[lastList.length - 1].to;
    // Step 11: `[color: ..]` after the label, or after the last name when there is none (eraser.io).
    let attrs: Attrs | null = null;
    const bracket = (at: number) => {
      attrs = this.attrs(at, e);
      stop = attrs.to;
      if (attrs.to > at && s.charCodeAt(attrs.to - 1) === 93) this.end(attrs.to, e);
    };
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
        const a = this.ws(ql.end, e);
        if (a < e && s.charCodeAt(a) === 91) bracket(a);
        else this.end(ql.end, e);
      } else {
        let j = r;
        while (j < e && !this.isComment(j, e)) j++;
        let to = this.trimBack(j, r);
        // A trailing [..] is attributes only when every key in it is one; otherwise it is the label's own text.
        const b = this.trailingAttrs(r, to);
        if (b >= 0) {
          attrs = this.attrs(b, to);
          stop = attrs.to;
          to = this.trimBack(b, r);
        }
        if (to > r) {
          label = s.slice(r, to);
          labelRange = { from: r, to };
          if (b < 0) stop = to;
        }
        if (j < e) this.comment(j, e);
      }
    } else if (q < e && s.charCodeAt(q) === 91) {
      bracket(q);
    } else {
      this.end(q, e);
    }
    const color = this.lineColour(attrs);
    const last = arrows.length - 1;
    const line = { from: head[0].from, to: stop };
    const dk = this.kind;
    const lineAttrs = attrs as Attrs | null;
    if (dk === "timeline") {
      this.error(line.from, stop, MESSAGES.noLines);
      return;
    }
    const fan = lists.some((l) => l.length > 1);
    if (fan) {
      if (dk === "sequence") {
        for (const l of lists) if (l.length > 1) this.error(l[0].from, l[l.length - 1].to, MESSAGES.oneParticipant);
        return;
      }
      let count = 0;
      for (let k = 0; k < arrows.length; k++) count += lists[k].length * lists[k + 1].length;
      if (count > MAX_FAN_LINKS) {
        this.error(line.from, line.to, MESSAGES.fanTooBig);
        return;
      }
    }
    // The span of a list with more than one name, for the fix that quotes an old name written with commas.
    const listRange = (l: Token[]) => (l.length > 1 ? [l[0].from, l[l.length - 1].to] : [-1, -1]);
    arrows.forEach((a, k) => {
      const old = dk === "er" && a.arrow in OLD_ER_ARROWS ? (a.arrow as OldErArrow) : null;
      const drawn: FlowArrow = old ? OLD_ER_ARROWS[old] : (a.arrow as FlowArrow);
      if (old) {
        const use = OLD_ER_ARROWS[old];
        this.oldForm(a.from, a.to, MESSAGES.oldCard(old, use), () => [{ title: FIX_TITLES.use(use), edits: [{ from: a.from, to: a.to, insert: use }] }]);
      } else if (a.arrow === "..>" && (dk === "dfd" || dk === "flow")) {
        this.error(a.from, a.to, MESSAGES.dotted, () => [{ title: FIX_TITLES.use("-->"), edits: [{ from: a.from, to: a.to, insert: "-->" }] }]);
      } else if (dk && !ARROWS[dk].includes(drawn)) {
        const use = ARROWS[dk][0];
        this.error(a.from, a.to, MESSAGES.arrowKind(a.arrow, dk, use), () => [{ title: FIX_TITLES.use(use), edits: [{ from: a.from, to: a.to, insert: use }] }]);
      }
      const ends = fan ? [...listRange(lists[k]), ...listRange(lists[k + 1])] : null;
      for (const from of lists[k]) {
        for (const to of lists[k + 1]) {
          // A state diagram's [*] is the start before the arrow and the end after it.
          // Inside a composite's braces it is that composite's own (diag-910 fix round 1, I4).
          const fromName = from.value === "[*]" && dk === "state" ? this.stateMark("start") : from.value;
          const toName = to.value === "[*]" && dk === "state" ? this.stateMark("end") : to.value;
          const link: FlowLink = { from: fromName, to: toName, arrow: drawn };
          const labelled = k === last && label !== undefined;
          if (labelled) link.label = label;
          // The label and the colour are the last segment's; such a link is written on its own, so it is not chained,
          // and neither is any link of a fan line.
          const coloured = k === last && color !== undefined;
          if (coloured) link.color = color;
          if (k > 0 && !fan && !labelled && !coloured) link.chained = true;
          const i = this.links.length;
          this.links.push(link);
          this.linkLines.push(this.line);
          if (ends) this.fanEnds.set(i, ends);
          const lab = labelled && labelRange ? labelRange : null;
          const own = k === last ? lineAttrs : null;
          // LINK_PARTS: fromName, toName, arrow, label, line, attrs. The undefined-name check reads the names from here.
          this.linkPacked[i] = [from.from, to.to, from.from, from.to, to.from, to.to, a.from, a.to, lab ? lab.from : -1, lab ? lab.to : -1, line.from, line.to, own ? own.from : -1, own ? own.to : -1];
        }
      }
    });
  }

  /**
   * Where a `[..]` that ends `from..to` starts when every item in it is `key: value` with a known key, else -1: such
   * a bracket after a line's label is its attributes, any other stays label text (step 11).
   */
  private trailingAttrs(from: number, to: number): number {
    const s = this.s;
    if (to <= from || s.charCodeAt(to - 1) !== 93) return -1;
    for (let b = s.lastIndexOf("[", to - 1); b >= from; b = b > 0 ? s.lastIndexOf("[", b - 1) : -1) {
      if (this.allKnown(b + 1, to - 1)) return b;
    }
    return -1;
  }

  /** True when `a..z` (inside brackets) is one or more `key: value` items, each key an attribute. */
  private allKnown(a: number, z: number): boolean {
    const s = this.s;
    const stops = (c: number) => c === 44 || c === 91 || c === 93;
    let j = a;
    for (;;) {
      j = this.ws(j, z);
      let k = j;
      while (k < z && s.charCodeAt(k) !== 58 && !stops(s.charCodeAt(k))) k++;
      if (k >= z || s.charCodeAt(k) !== 58) return false;
      if (!(ATTR_KEYS as readonly string[]).includes(s.slice(j, this.trimBack(k, j)))) return false;
      let v = this.ws(k + 1, z);
      if (v < z && s.charCodeAt(v) === 34) {
        const q = this.quoted(v, z);
        if (!q) return false;
        v = this.ws(q.end, z);
      } else {
        const v0 = v;
        while (v < z && !stops(s.charCodeAt(v))) v++;
        if (this.trimBack(v, v0) === v0) return false;
      }
      if (v >= z) return true;
      if (s.charCodeAt(v) !== 44) return false;
      j = v + 1;
    }
  }

  /** A sequence frame's brackets take a colour only (`MESSAGES.blockAttrs`); the colour is checked like a line's. */
  private blockAttrs(attrs: Attrs) {
    const s = this.s;
    const items = [...(attrs.kind ? [attrs.kind] : []), ...attrs.keys.filter((k) => k !== "color").map((k) => attrs.items[k])];
    const only = (attrs.kind ? 1 : 0) + attrs.keys.length === 1;
    for (const item of items) {
      this.error(item.from, item.to, MESSAGES.blockAttrs, () => {
        if (!only) return [{ title: FIX_TITLES.remove, edits: [this.removeItem(item)] }];
        let from = attrs.from;
        while (from > 0 && (s.charCodeAt(from - 1) === 32 || s.charCodeAt(from - 1) === 9)) from--;
        return [{ title: FIX_TITLES.remove, edits: [{ from, to: attrs.to, insert: "" }] }];
      });
    }
    this.checkColour(attrs.attrs.color, attrs.values.color);
  }

  /** A line's colour from its brackets, with a problem for what a line does not take (step 11). */
  private lineColour(attrs: Attrs | null): string | undefined {
    if (!attrs) return undefined;
    const dk = this.kind;
    const s = this.s;
    if (dk && !LINE_COLOUR_DIAGRAMS.has(dk)) {
      if (dk === "timeline") return undefined;
      let from = attrs.from;
      while (from > 0 && (s.charCodeAt(from - 1) === 32 || s.charCodeAt(from - 1) === 9)) from--;
      this.error(attrs.from, attrs.to, MESSAGES.noLineColour(dk), () => [{ title: FIX_TITLES.remove, edits: [{ from, to: attrs.to, insert: "" }] }]);
      return undefined;
    }
    if (attrs.kind) {
      const k = attrs.kind;
      this.error(k.from, k.to, MESSAGES.lineAttrs, () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(k)] }]);
    }
    for (const key of attrs.keys) {
      if (key === "color") continue;
      const item = attrs.items[key];
      this.error(item.from, item.to, MESSAGES.lineAttrs, () => [{ title: FIX_TITLES.remove, edits: [this.removeItem(item)] }]);
    }
    this.checkColour(attrs.attrs.color, attrs.values.color);
    return attrs.attrs.color;
  }

  /** The `[*]` marker a link line names here: the open composite's own, else the diagram's (I4). */
  private stateMark(end: "start" | "end"): string {
    const g = this.stack[this.stack.length - 1];
    if (!g || g.repeated) {
      this.stateMarks[end] = true;
      return end === "start" ? STATE_START : STATE_END;
    }
    const name = stateMarkerName(end, g.name);
    if (!this.byName.has(name)) {
      const node: FlowNode = { name, kind: end, attrs: {} } as FlowNode;
      this.byName.set(name, node);
      this.nodes.push({ node, grouped: true });
      g.nodes.push(name);
    }
    return name;
  }

  // ----- after the last line

  private finish() {
    const s = this.s;
    if (!this.header) {
      this.error(0, 0, MESSAGES.firstLine, () => DIAGRAM_KINDS.map((k) => ({ title: FIX_TITLES.addFirstLine(k), edits: [{ from: 0, to: 0, insert: `diagram ${k} "Untitled"\n` }] })), 1);
    }
    const t = this.table;
    if (t) {
      this.error(t.from, t.nameTo, MESSAGES.unclosed(t.name), () => [{ title: FIX_TITLES.closeGroup, edits: [{ from: s.length, to: s.length, insert: s.endsWith("\n") ? "}\n" : "\n}\n" }] }], t.line);
      if (t.node) {
        const end = this.trimBack(s.length, t.from);
        for (const key of [`node:${t.name}`, `table:${t.name}`]) {
          const span = this.packed.get(key);
          if (span) span[1] = end;
        }
      }
    }
    for (const g of this.stack) {
      const insert = s.endsWith("\n") ? "}\n" : "\n}\n";
      this.error(g.from, g.nameTo, MESSAGES.unclosed(g.name), () => [{ title: FIX_TITLES.closeGroup, edits: [{ from: s.length, to: s.length, insert }] }], g.line);
      const span = g.repeated ? undefined : this.packed.get(`group:${g.name}`);
      if (span) span[1] = this.trimBack(s.length, g.from);
    }
    for (const f of this.frameStack) {
      this.error(f.at, f.nameTo, MESSAGES.unclosedFrame(f.label), () => [{ title: FIX_TITLES.closeGroup, edits: [{ from: s.length, to: s.length, insert: s.endsWith("\n") ? "}\n" : "\n}\n" }] }], f.line);
    }
    for (const [name, from] of this.openActs) this.activations.push({ name, from, to: this.links.length - 1 });
    // A sequence names its participants by using them (a declared one keeps its place and kind).
    if (this.kind === "sequence") {
      this.links.forEach((l, i) => {
        for (const name of [l.from, l.to]) {
          if (this.defs.has(name)) continue;
          this.defs.set(name, this.linkLines[i]);
          const node: FlowNode = { name, kind: "participant", attrs: {} };
          this.nodes.push({ node, grouped: false });
          this.byName.set(name, node);
        }
      });
    }
    if (this.kind === "mindmap" && this.nodes.length > 0 && !this.nodes.some((n) => n.node.kind === "root")) {
      this.problem("hint", 0, 0, MESSAGES.noRoot, () => [], 1);
    }
    if (this.kind === "er") this.columnEnds();
    // A fan line expands to several links sharing the same name tokens and span: each is reported once.
    const reported = new Set<number>();
    const hinted = new Set<number>();
    this.links.forEach((l, i) => {
      const p = this.linkPacked[i];
      const line = this.linkLines[i];
      for (const end of ["from", "to"] as const) {
        const name = end === "from" ? l.from : l.to;
        if (this.defs.has(name) || (this.kind === "state" && isStateMarker(name))) continue;
        const tokenFrom = p[end === "from" ? 2 : 4];
        if (reported.has(tokenFrom)) continue;
        reported.add(tokenFrom);
        const fanList = this.fanEnds.get(i);
        const at = end === "from" ? 0 : 2;
        const list = fanList && fanList[at] >= 0 ? { from: fanList[at], to: fanList[at + 1] } : null;
        const u: Use = { name, from: p[end === "from" ? 2 : 4], to: p[end === "from" ? 3 : 5], line, end, other: end === "from" ? l.to : l.from, list };
        // Step 11: an end that matches only a label means a shape by the words it shows; lines name it by its name.
        const shows = this.namesShowing(name);
        if (shows.length > 0) {
          const fixes = () => shows.map((n) => ({ title: FIX_TITLES.use(n), edits: [{ from: u.from, to: u.to, insert: flowName(n) }] }));
          this.error(u.from, u.to, shows.length === 1 ? MESSAGES.isLabel(name, flowName(shows[0])) : MESSAGES.sharedLabel(name), fixes, line);
          continue;
        }
        this.error(u.from, u.to, MESSAGES.notDefined(name), () => this.undefinedFixes(u), line);
      }
      if (this.kind === "flow" && l.label === undefined && this.byName.get(l.from)?.kind === "decision" && !hinted.has(p[0])) {
        hinted.add(p[0]);
        this.problem("hint", p[0], p[1], MESSAGES.decisionLabels, () => [], line);
      }
    });
  }

  /** The names of the shapes whose `label:` is `label`, in the order they are defined. */
  private namesShowing(label: string): string[] {
    if (this.labels.size === 0) return [];
    if (!this.showing) {
      const m = new Map<string, string[]>();
      for (const [name, l] of this.labels) m.set(l, [...(m.get(l) ?? []), name]);
      this.showing = m;
    }
    return this.showing.get(label) ?? [];
  }

  private undefinedFixes(u: Use): QuickFix[] {
    const s = this.s;
    const kind = this.addKind(u);
    const fixes: QuickFix[] = [];
    // An old name written with commas (`Pay, ship > Done`) now reads as a list: quoting it keeps its meaning.
    if (u.list) {
      const joined = s.slice(u.list.from, u.list.to);
      if (this.defs.has(joined)) fixes.push({ title: FIX_TITLES.useQuoted(joined), edits: [{ from: u.list.from, to: u.list.to, insert: flowName(joined) }] });
    }
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
    if (this.kind === "er") return "entity";
    if (this.kind === "state") return "state";
    if (this.kind === "class") return "class";
    if (this.kind === "mindmap") return "topic";
    if (this.kind !== "dfd") return "step";
    const other = this.byName.get(u.other)?.kind;
    if (other === "store" || other === "entity") return "process";
    return u.end === "to" ? "store" : "entity";
  }

  private addLine(name: string, kind: FlowNodeKind): string {
    if (kind === "service") return flowName(name);
    if (this.kind !== "dfd" && this.kind !== "flow") return nodeStatement(this.kind, { name, kind, attrs: {} });
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
      if (g.color !== undefined) group.color = g.color;
      into.push(group);
      for (let i = g.groups.length - 1; i >= 0; i--) stack.push({ g: g.groups[i], into: group.groups });
    }
    if (kind === "state") {
      if (this.stateMarks.end) nodes.unshift({ name: STATE_END, kind: "end", attrs: {} });
      if (this.stateMarks.start) nodes.unshift({ name: STATE_START, kind: "start", attrs: {} });
    }
    const doc: FlowDoc = { kind, title: this.title, comments: this.comments, nodes, links: this.treeLinks.length ? [...this.links, ...this.treeLinks] : this.links, groups };
    if (kind === "sequence") {
      doc.frames = this.frames;
      doc.activations = this.activations;
      if (this.numbering.length) doc.autonumber = this.numbering;
    }
    if (kind === "timeline") doc.sections = this.sections;
    return doc;
  }
}

/** An ER row's column name: the row up to its first white space ("customer_id int" is customer_id). */
function columnName(row: string): string {
  let j = 0;
  while (j < row.length && !isWs(row.charCodeAt(j))) j++;
  return row.slice(0, j);
}

/** Parses .flow text; never throws on odd text, and reports what is wrong as problems with fixes. */
export function parseFlow(text: string, opts: FlowParseOptions = {}): FlowParse {
  return new Parser(text, opts).run();
}
