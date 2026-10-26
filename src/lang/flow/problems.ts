// What the .flow parser says when the text is wrong, in plain words (spec section 2, frame 6+.3).
import type { QuickFix } from "../protocol";
import { ATTR_KEYS, DIAGRAM_KINDS, type DiagramKind, type FlowNodeKind, KINDS, quote } from "./model";
import { article } from "../../format/article";

export type FlowProblem = {
  /** 1-based. */
  line: number;
  /** Offsets into the text. */
  from: number;
  to: number;
  /** A hint never stops the drawing; an error keeps the last good one. */
  severity: "error" | "hint";
  message: string;
  fixes: QuickFix[];
};

/** The kind in words, inside a sentence. */
const KIND_WORDS: Record<DiagramKind, string> = {
  dfd: "data flow",
  flow: "flowchart",
  cloud: "cloud",
  er: "ER",
  sequence: "sequence",
  state: "state",
  class: "class",
  mindmap: "mind map",
  timeline: "timeline",
};

/** "A data flow", "An ER": the kind with its article, starting a sentence. */
function aKind(kind: DiagramKind): string {
  const words = article(KIND_WORDS[kind]);
  return words[0].toUpperCase() + words.slice(1);
}

/** How the kinds without bracket words are written. */
const LEADING: Partial<Record<DiagramKind, string>> = {
  sequence: "Start the line with participant or actor.",
  class: "Start the line with class, interface or enum.",
  mindmap: "Indent a topic under its parent instead.",
  timeline: "Start the line with a date or milestone.",
};

/** "a, b or c". */
function either(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}


export const MESSAGES = {
  firstLine: "The first line must say diagram and a kind, such as diagram dfd, diagram flow or diagram sequence.",
  notAKind: (word: string, use: DiagramKind | null) =>
    `${word} is not a diagram kind. Use ${use ?? `one of: ${DIAGRAM_KINDS.join(", ")}`}.`,
  arrowKind: (arrow: string, kind: DiagramKind, use: string) => `${aKind(kind)} diagram does not draw ${arrow}. Use ${use}.`,
  noLines: "A timeline has no lines between items: its order comes from the dates.",
  bracketKinds: (kind: DiagramKind) => `${aKind(kind)} diagram takes no kind in brackets. ${LEADING[kind] ?? ""}`.trim(),
  badDate: "Write the date as YYYY-MM-DD, YYYY-MM or YYYY, for example 2026-10-19.",
  timelineLine: "A timeline line starts with a date, milestone or section, for example 2026-10-19: Release.",
  needsColon: "Put a colon after the date, then the name, for example 2026-10-19: Release.",
  noFrame: "This } closes no frame.",
  frameNeedsBrace: "A frame ends its first line with {, for example loop retry 3 times {.",
  unclosedFrame: (label: string) => `${label} has no closing }.`,
  noColumn: (table: string, column: string) => `${table} has no column ${column}.`,
  tableInTable: "A table holds columns. Put tables side by side, or in a group: group Billing {.",
  columnName: "Start a column with its name, for example id int pk.",
  openParen: "This ( has no closing ).",
  oldColumn: "Columns go inside their table's braces now.",
  oldGroup: "Groups start with the word group now: group Name {.",
  oldCard: (arrow: string, use: string) => `${arrow} is the old way to write a relationship. Use ${use}.`,
  unknownFlag: (word: string, near: string | null) =>
    near ? `Unknown column flag "${word}". Did you mean ${near}?` : `Unknown column flag "${word}". Use pk, not null or unique.`,
  noClass: (name: string) => `${name} is not a class. Add class ${name} first.`,
  noRoot: "A mind map starts with its central idea, for example root Q4 plan.",
  dfdNeedsKind: "A data flow node needs a kind: entity, process or store.",
  decisionLabels: "A decision needs a label on each way out, for example yes and no.",
  cloudKind: "A cloud node takes an icon, not a kind, for example [icon: aws-s3].",
  participantAttrs: "A participant takes an icon, a label and a colour, for example [icon: aws-lambda, color: info].",
  groupAttrs: "A group takes only an icon and a colour, for example [icon: aws-vpc, color: muted].",
  // Step 11: the colour palette and label:.
  notAColour: (value: string, near: string | null) =>
    near
      ? `${value} is not a colour. Did you mean ${near}?`
      : `${value || "An empty value"} is not a colour. Use a preset such as accent, a CSS colour name such as teal, or a hex such as "#3b82f6".`,
  noAttrHere: (_key: string, kind: DiagramKind) => `${aKind(kind)} diagram's shapes take no colour or label.`,
  noLineColour: (kind: DiagramKind) => `${aKind(kind)} diagram's lines take no colour.`,
  lineAttrs: "A line takes only a colour, for example [color: warning].",
  isLabel: (label: string, name: string) => `${label} is a label: lines name a shape by its name, so write ${name}.`,
  sharedLabel: (label: string) => `Several shapes show ${label}: a line names one by its name.`,
  dotted: "The dotted line ..> is for cloud diagrams only.",
  openList: "This list has no closing ].",
  strayClose: "This } closes no group.",
  needsName: "Start the line with a name.",
  oneKind: "Only one kind goes in the brackets.",
  nameQuote: "This name has no closing quote.",
  titleQuote: "This title has no closing quote.",
  textQuote: "This text has no closing quote.",
  tooDeep: "Groups nest at most 20 deep.",
  notDefined: (name: string) => `${name} is not defined.`,
  definedTwice: (name: string, first: number, second: number) => `${name} is defined twice (lines ${first} and ${second}).`,
  unknownKind: (word: string, kind: DiagramKind | null, near: string | null) =>
    near ? `Unknown kind "${word}". Did you mean ${near}?` : `Unknown kind "${word}". Use ${either(kind ? KINDS[kind] : [...KINDS.dfd, ...KINDS.flow])}.`,
  unknownAttr: (key: string) => `Unknown attribute "${key}". Use ${either(ATTR_KEYS)}.`,
  noValue: (key: string) => `${key} needs a value.`,
  notAnIcon: (icon: string, near: string | null) => (near ? `${icon} is not an icon. Did you mean ${near}?` : `${icon} is not an icon.`),
  noTarget: (arrow: string) => `This link needs a name after ${arrow}.`,
  listName: "Put a name after the comma.",
  listNameBefore: "Put a name before the comma.",
  fanTooBig: "One line makes at most 100 links. Split it into several lines.",
  oneParticipant: "A message goes to one participant. Write one line per message.",
  unclosed: (group: string) => `${group} has no closing }.`,
  frameTwice: (title: string, first: number, second: number) => `Two diagrams on this board are called ${title || "Untitled"} (lines ${first} and ${second}).`,
  tooManyFrames: "A board holds at most 50 diagrams. This one and the ones after it are not read.",
  tooManyShapes: "This board has more than 10,000 shapes. Move some diagrams to a new board.",
  extra: (text: string) => {
    // A quoted token already has its quotes: show what is inside them in one pair.
    const inner = text.length >= 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : text;
    return `Can't read "${inner.length > 24 ? `${inner.slice(0, 24)}...` : inner}" here.`;
  },
};

export const FIX_TITLES = {
  kind: (diagram: DiagramKind) => `Make it diagram ${diagram}`,
  addFirstLine: (diagram: DiagramKind) => `Add diagram ${diagram}`,
  addAs: (name: string, kind: FlowNodeKind) => `Add ${name} as ${article(kind)}`,
  sendTo: (name: string) => `Send it to ${name}`,
  sendFrom: (name: string) => `Send it from ${name}`,
  renameSecond: "Rename the second one",
  makeKind: (kind: FlowNodeKind) => `Make it ${article(kind)}`,
  use: (word: string) => `Use ${word}`,
  useQuoted: (name: string) => `Use ${quote(name)}`,
  closeGroup: "Add } at the end",
  rewriteBlocks: "Rewrite as table blocks",
  remove: "Remove it",
};

/** The banner over the faded last good drawing while line `line` has an error. */
export function staleBanner(line: number): string {
  return `Showing the last drawing that worked. Fix line ${line} to update it.`;
}

// Two rows reused by every call, so comparing against thousands of names allocates nothing.
let rowA = new Int32Array(64);
let rowB = new Int32Array(64);

/** Levenshtein distance, giving up past `limit` (returns `limit + 1`). */
export function editDistance(a: string, b: string, limit = Infinity): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  if (rowA.length <= b.length) {
    rowA = new Int32Array(b.length + 1);
    rowB = new Int32Array(b.length + 1);
  }
  let prev = rowA;
  let row = rowB;
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    row[0] = i;
    let best = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ca === b.charCodeAt(j - 1) ? 0 : 1));
      row[j] = v;
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    const t = prev;
    prev = row;
    row = t;
  }
  return prev[b.length];
}

/** The one closest word, close enough to be a typo (an edit per four letters, at least one); ties keep the list order. */
export function nearWord(word: string, words: Iterable<string>): string | null {
  const w = word.toLowerCase();
  const limit = Math.max(1, Math.floor(w.length / 4));
  let best: string | null = null;
  let bestD = limit + 1;
  for (const candidate of words) {
    const d = editDistance(w, candidate.toLowerCase(), bestD - 1 < limit ? bestD - 1 : limit);
    if (d === 0) return candidate === word ? null : candidate;
    if (d < bestD) {
      best = candidate;
      bestD = d;
    }
  }
  return best;
}

/** Names that long are not typos of anything worth comparing. */
const MAX_COMPARED = 200;

/**
 * Up to `count` names nearest to `word` by edit distance, ties in list order. A higher `band` puts a candidate in a later
 * group, so a data flow offers its own processes and stores before its outside parties.
 */
export function nearestNames(
  word: string,
  candidates: readonly { name: string; lower: string; band: number }[],
  count: number,
  skip: (name: string) => boolean = () => false,
): string[] {
  if (word.length > MAX_COMPARED) return [];
  const w = word.toLowerCase();
  const best: { name: string; band: number; d: number; at: number }[] = [];
  const worse = (a: { band: number; d: number; at: number }, b: { band: number; d: number; at: number }) =>
    a.band !== b.band ? a.band > b.band : a.d !== b.d ? a.d > b.d : a.at > b.at;
  candidates.forEach((c, at) => {
    if (c.name.length > MAX_COMPARED || skip(c.name)) return;
    const full = best.length >= count ? best[best.length - 1] : null;
    if (full && c.band > full.band) return;
    const limit = full && c.band === full.band ? full.d : Infinity;
    const d = editDistance(w, c.lower, limit);
    const entry = { name: c.name, band: c.band, d, at };
    if (full && !worse(full, entry)) return;
    best.push(entry);
    best.sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0));
    if (best.length > count) best.pop();
  });
  return best.map((b) => b.name);
}
