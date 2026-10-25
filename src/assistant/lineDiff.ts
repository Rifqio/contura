export type DiffLine = { op: "same" | "del" | "add"; text: string };

/** The most cells the common subsequence table may take (about 8 MB of numbers). */
export const DIFF_CELLS_MAX = 1_000_000;

const linesOf = (s: string): string[] => (s === "" ? [] : s.split(/\r?\n/));

/** A line diff by longest common subsequence; within a change, removed lines come before added ones. */
export function lineDiff(before: string, after: string): DiffLine[] {
  return diffLines(linesOf(before), linesOf(after));
}

/** `lineDiff` over lines already split, so an empty line counts as one. */
export function diffLines(a: readonly string[], b: readonly string[]): DiffLine[] {
  // The table is a.length x b.length numbers: past this, every old line goes and every new one comes.
  if (a.length * b.length > DIFF_CELLS_MAX)
    return [...a.map((text) => ({ op: "del" as const, text })), ...b.map((text) => ({ op: "add" as const, text }))];
  // lcs[i][j]: the common subsequence length of a[i..] and b[j..].
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (j >= b.length || (i < a.length && lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ op: "del", text: a[i++] });
    } else {
      out.push({ op: "add", text: b[j++] });
    }
  }
  return out;
}
