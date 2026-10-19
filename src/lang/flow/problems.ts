// What the .flow parser says when the text is wrong, in plain words (spec section 2, frame 6+.3).
import type { QuickFix } from "../protocol";
import { ATTR_KEYS, type DiagramKind, type FlowNodeKind, KINDS } from "./model";
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

/** "a, b or c". */
function either(words: readonly string[]): string {
  return words.length < 2 ? words.join("") : `${words.slice(0, -1).join(", ")} or ${words[words.length - 1]}`;
}


export const MESSAGES = {
  firstLine: "The first line must say diagram dfd, diagram flow or diagram cloud.",
  dfdNeedsKind: "A data flow node needs a kind: entity, process or store.",
  decisionLabels: "A decision needs a label on each way out, for example yes and no.",
  cloudKind: "A cloud node takes an icon, not a kind, for example [icon: aws-s3].",
  groupAttrs: "A group takes only an icon, for example [icon: aws-vpc].",
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
  unclosed: (group: string) => `${group} has no closing }.`,
  extra: (text: string) => `Can't read "${text.length > 24 ? `${text.slice(0, 24)}...` : text}" here.`,
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
  closeGroup: "Add } at the end",
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
