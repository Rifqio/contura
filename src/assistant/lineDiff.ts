export type DiffLine = { op: "same" | "del" | "add"; text: string };

/** The most cells the common subsequence table may take (4 MB as 32-bit counts). */
export const DIFF_CELLS_MAX = 1_000_000;

const linesOf = (s: string): string[] => (s === "" ? [] : s.split(/\r?\n/));

/** A line diff by longest common subsequence; within a change, removed lines come before added ones. */
export function lineDiff(before: string, after: string): DiffLine[] {
  return diffLines(linesOf(before), linesOf(after));
}

/**
 * `lineDiff` over lines already split, so an empty line counts as one. The lines both share at the head and the tail
 * stay out of the table; past DIFF_CELLS_MAX for what is left, its old lines all go and its new ones all come.
 */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const out: DiffLine[] = [];
  for (let k = 0; k < head; k++) out.push({ op: "same", text: a[k] });
  diffMiddle(a, b, head, a.length - tail, head, b.length - tail, out);
  for (let k = a.length - tail; k < a.length; k++) out.push({ op: "same", text: a[k] });
  return out;
}

/** The LCS diff of `a[a0, a1)` against `b[b0, b1)`, pushed onto `out`; a whole replace past the cap. */
function diffMiddle(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number, out: DiffLine[]): void {
  const n = a1 - a0;
  const m = b1 - b0;
  // The table is n x m numbers: past this, every old line goes and every new one comes.
  if (n * m > DIFF_CELLS_MAX) {
    for (let i = a0; i < a1; i++) out.push({ op: "del", text: a[i] });
    for (let j = b0; j < b1; j++) out.push({ op: "add", text: b[j] });
    return;
  }
  // lcs[i * w + j]: the common subsequence length of a[a0 + i..a1) and b[b0 + j..b1), in one flat typed array.
  const w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    const ai = a[a0 + i];
    const row = i * w;
    for (let j = m - 1; j >= 0; j--) {
      const down = lcs[row + w + j];
      const right = lcs[row + j + 1];
      lcs[row + j] = ai === b[b0 + j] ? lcs[row + w + j + 1] + 1 : down >= right ? down : right;
    }
  }
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[a0 + i] === b[b0 + j]) {
      out.push({ op: "same", text: a[a0 + i] });
      i++;
      j++;
    } else if (j >= m || (i < n && lcs[(i + 1) * w + j] >= lcs[i * w + j + 1])) {
      out.push({ op: "del", text: a[a0 + i++] });
    } else {
      out.push({ op: "add", text: b[b0 + j++] });
    }
  }
}
