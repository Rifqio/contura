/**
 * Quick Open's fuzzy match, as VS Code's: the query's letters in order anywhere in the target, scored so a run of
 * letters beats scattered ones, a word start beats the middle of a word, and the name beats its schema.
 */

export interface FuzzyMatch {
  score: number;
  /** Where each query letter matched in the target. */
  positions: number[];
}

const SEPARATORS = "._- :";

/**
 * Lower case letter by letter, so each position still names the same letter of `text` ("İ" lowers to two code
 * units and would shift every mark after it).
 */
export function foldCase(text: string): string {
  const whole = text.toLowerCase();
  if (whole.length === text.length) return whole;
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const l = text[i].toLowerCase();
    out += l.length === 1 ? l : text[i];
  }
  return out;
}
const NONE = -1e9;

/** A letter that starts a word: the first, one after a separator, or a capital after a small letter. */
export function isWordStart(target: string, j: number): boolean {
  if (j === 0) return true;
  const prev = target[j - 1];
  if (SEPARATORS.includes(prev)) return true;
  const cur = target[j];
  return prev === prev.toLowerCase() && prev !== prev.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Matches `query` (no spaces, any case) against `target`, where the name starts at `nameFrom` (after "schema.").
 * Null when the letters are not all there in order. Linear in the target per query letter.
 */
export function fuzzyMatch(query: string, target: string, nameFrom = 0): FuzzyMatch | null {
  const q = foldCase(query);
  const t = foldCase(target);
  const n = q.length;
  const len = t.length;
  if (n === 0) return { score: 0, positions: [] };
  if (n > len) return null;
  // Cheap reject first: most targets do not hold the letters at all.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = t.indexOf(q[i], j);
    if (j < 0) return null;
  }
  const bonus = (j: number) => 1 + (isWordStart(target, j) ? 8 : 0) + (j === nameFrom ? 4 : 0) + (j >= nameFrom ? 2 : 0);
  let prev = new Float64Array(len).fill(NONE);
  const back: Int32Array[] = [];
  for (let j = 0; j < len; j++) {
    if (t[j] === q[0]) prev[j] = bonus(j) - (j >= nameFrom ? j - nameFrom : j + 20) * 0.05;
  }
  back.push(new Int32Array(len).fill(-1));
  for (let i = 1; i < n; i++) {
    const cur = new Float64Array(len).fill(NONE);
    const from = new Int32Array(len).fill(-1);
    // The best score of the previous letter at any k < j - 1, and where (the earliest on a tie).
    let best = NONE;
    let bestAt = -1;
    for (let j = i; j < len; j++) {
      const k = j - 2;
      if (k >= 0 && prev[k] > best) {
        best = prev[k];
        bestAt = k;
      }
      if (t[j] !== q[i]) continue;
      let score = best;
      let at = bestAt;
      // The letter right before: a run, worth 10 more.
      if (prev[j - 1] !== NONE && prev[j - 1] + 10 > score) {
        score = prev[j - 1] + 10;
        at = j - 1;
      }
      if (at < 0) continue;
      cur[j] = score + bonus(j);
      from[j] = at;
    }
    prev = cur;
    back.push(from);
  }
  let score = NONE;
  let end = -1;
  for (let j = 0; j < len; j++) {
    if (prev[j] > score) {
      score = prev[j];
      end = j;
    }
  }
  if (end < 0) return null;
  const positions = new Array<number>(n);
  for (let i = n - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = back[i][j];
  }
  return { score, positions };
}

/**
 * `fuzzyMatch`'s score alone, for ranking many names on each key: no positions and no allocation per name. The
 * caller keeps each name folded (`foldCase`) and its word starts (`isWordStart`, 1 or 0) from when the list was made.
 * Gives the same score as `fuzzyMatch`, so the rows drawn get their marks from it afterwards.
 */
export class FuzzyScorer {
  private prev = new Float64Array(64);
  private cur = new Float64Array(64);

  /** The score, or NaN when the letters are not all there in order. `starts[startsAt + j]` is letter j's flag. */
  score(q: string, t: string, starts: Uint8Array, startsAt: number, nameFrom: number): number {
    const n = q.length;
    const len = t.length;
    if (n === 0) return 0;
    if (n > len) return NaN;
    for (let i = 0, j = 0; i < n; i++, j++) {
      j = t.indexOf(q[i], j);
      if (j < 0) return NaN;
    }
    if (this.prev.length < len) {
      this.prev = new Float64Array(len * 2);
      this.cur = new Float64Array(len * 2);
    }
    let prev = this.prev;
    let cur = this.cur;
    const q0 = q.charCodeAt(0);
    for (let j = 0; j < len; j++) {
      if (t.charCodeAt(j) !== q0) {
        prev[j] = NONE;
        continue;
      }
      const bonus = 1 + (starts[startsAt + j] ? 8 : 0) + (j === nameFrom ? 4 : 0) + (j >= nameFrom ? 2 : 0);
      prev[j] = bonus - (j >= nameFrom ? j - nameFrom : j + 20) * 0.05;
    }
    for (let i = 1; i < n; i++) {
      const qi = q.charCodeAt(i);
      let best = NONE;
      for (let j = 0; j < i && j < len; j++) cur[j] = NONE;
      for (let j = i; j < len; j++) {
        const k = j - 2;
        if (k >= 0 && prev[k] > best) best = prev[k];
        if (t.charCodeAt(j) !== qi) {
          cur[j] = NONE;
          continue;
        }
        let score = best;
        if (prev[j - 1] !== NONE && prev[j - 1] + 10 > score) score = prev[j - 1] + 10;
        if (score === NONE) {
          cur[j] = NONE;
          continue;
        }
        cur[j] = score + 1 + (starts[startsAt + j] ? 8 : 0) + (j === nameFrom ? 4 : 0) + (j >= nameFrom ? 2 : 0);
      }
      const swap = prev;
      prev = cur;
      cur = swap;
    }
    let top = NONE;
    for (let j = 0; j < len; j++) if (prev[j] > top) top = prev[j];
    return top === NONE ? NaN : top;
  }
}

export interface HighlightPart {
  text: string;
  hit: boolean;
}

/** `text` cut into runs of matched and plain letters; `offset` is where `text` starts in the matched target. */
export function highlightParts(text: string, offset: number, positions: readonly number[]): HighlightPart[] {
  const hits = new Set(positions.map((p) => p - offset));
  const out: HighlightPart[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = hits.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
