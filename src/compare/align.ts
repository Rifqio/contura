/**
 * Side-by-side line alignment for the DDL panes: a longest common subsequence over whole lines,
 * then, between two common lines, a source line and a target line that start with the same name
 * (a column, a value) pair up as one changed row; the rest are in one side only, with a filler
 * row opposite.
 */

/** same: both sides. changed: both, differing. added: in the source only. removed: in the target only. */
export type LineMark = "same" | "changed" | "added" | "removed";

export interface AlignedSide {
  /** 1-based line number on its own side. */
  n: number;
  text: string;
}

export interface AlignedRow {
  mark: LineMark;
  /** The source line; null is a filler row. */
  left: AlignedSide | null;
  /** The target line; null is a filler row. */
  right: AlignedSide | null;
}

const unquote = (w: string) => w.replace(/,$/, "").replace(/^["'`[]|["'`\]]$/g, "");

/**
 * What a line defines, so a line pairs only with the same thing on the other side: the column or
 * enum value (its first word), or for an index, a constraint or an ALTER TABLE its object's name.
 */
export function lineKey(line: string): string {
  const words = line.trim().split(/\s+/);
  const upper = words.map((w) => w.toUpperCase());
  if (upper[0] === "CREATE" && (upper[1] === "INDEX" || (upper[1] === "UNIQUE" && upper[2] === "INDEX"))) {
    return `index ${unquote(words[upper[1] === "UNIQUE" ? 3 : 2] ?? "")}`;
  }
  if (upper[0] === "CONSTRAINT") return `constraint ${unquote(words[1] ?? "")}`;
  if (upper[0] === "ALTER" && upper[1] === "TABLE") return `alter ${words.slice(2).join(" ")}`;
  if (upper[0] === "PRIMARY" && upper[1] === "KEY") return "primary key";
  return unquote(words[0] ?? "");
}

type Op = { k: "eq"; l: number; r: number } | { k: "l"; l: number } | { k: "r"; r: number };

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  // suffix LCS lengths, row-major (n + 1) x (m + 1)
  const t = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number) => i * (m + 1) + j;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      t[at(i, j)] = a[i] === b[j] ? t[at(i + 1, j + 1)] + 1 : Math.max(t[at(i + 1, j)], t[at(i, j + 1)]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) ops.push({ k: "eq", l: i++, r: j++ });
    else if (t[at(i + 1, j)] >= t[at(i, j + 1)]) ops.push({ k: "l", l: i++ });
    else ops.push({ k: "r", r: j++ });
  }
  while (i < n) ops.push({ k: "l", l: i++ });
  while (j < m) ops.push({ k: "r", r: j++ });
  return ops;
}

/** Aligns the source lines `left` with the target lines `right`. */
export function alignLines(left: string[], right: string[]): AlignedRow[] {
  const rows: AlignedRow[] = [];
  const L = (i: number): AlignedSide => ({ n: i + 1, text: left[i] });
  const R = (j: number): AlignedSide => ({ n: j + 1, text: right[j] });

  /** One gap between common lines: pair by key, keep each side's order. */
  function flush(ls: number[], rs: number[]) {
    const used = new Set<number>();
    const pairOf = new Map<number, number>();
    // Pairs keep both sides in order: a match behind the last paired target line is not taken.
    let floor = -1;
    for (const i of ls) {
      const key = lineKey(left[i]);
      const j = rs.find((x) => x > floor && !used.has(x) && lineKey(right[x]) === key);
      if (j !== undefined) {
        used.add(j);
        pairOf.set(i, j);
        floor = j;
      }
    }
    let next = 0; // the next target line of the gap not yet written
    for (const i of ls) {
      const j = pairOf.get(i);
      if (j === undefined) {
        rows.push({ mark: "added", left: L(i), right: null });
        continue;
      }
      // Target-only lines that come before this pair go first.
      while (next < rs.length && rs[next] !== j) {
        if (!used.has(rs[next])) rows.push({ mark: "removed", left: null, right: R(rs[next]) });
        next++;
      }
      rows.push({ mark: "changed", left: L(i), right: R(j) });
      next++;
    }
    for (; next < rs.length; next++) if (!used.has(rs[next])) rows.push({ mark: "removed", left: null, right: R(rs[next]) });
  }

  let ls: number[] = [];
  let rs: number[] = [];
  for (const op of lcsOps(left, right)) {
    if (op.k === "l") ls.push(op.l);
    else if (op.k === "r") rs.push(op.r);
    else {
      flush(ls, rs);
      ls = [];
      rs = [];
      rows.push({ mark: "same", left: L(op.l), right: R(op.r) });
    }
  }
  flush(ls, rs);
  return rows;
}

/** A DDL text as lines; none for a side that does not have the object. */
export function ddlLines(text: string | null): string[] {
  if (text === null || text === "") return [];
  return text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
}
